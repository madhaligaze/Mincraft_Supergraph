/**
 * Shader loading, `#include` resolution, and program objects with a uniform
 * location cache.
 *
 * All .glsl files under ./shaders are inlined at build time by Vite, so there
 * is no runtime fetch and no async gap before the first frame.
 */

const SOURCES = import.meta.glob('./shaders/**/*.glsl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Normalises the glob keys ('./shaders/lib/pbr.glsl') to 'lib/pbr.glsl'. */
const LIBRARY = new Map<string, string>();
for (const [key, source] of Object.entries(SOURCES)) {
  LIBRARY.set(key.replace(/^\.\/shaders\//, ''), source);
}

const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm;

/**
 * Resolves `#include "path"` recursively. Each file is inlined once per
 * program; repeated includes become a comment so headers can be included
 * defensively without producing duplicate definitions.
 */
function resolveIncludes(name: string, seen: Set<string>): string {
  const source = LIBRARY.get(name);
  if (source === undefined) {
    throw new Error(`Шейдер не найден: ${name}`);
  }
  if (seen.has(name)) return `// (already included: ${name})\n`;
  seen.add(name);

  INCLUDE_RE.lastIndex = 0;
  return source.replace(INCLUDE_RE, (_match, includePath: string) => {
    const resolved = includePath.startsWith('lib/') || includePath.includes('/')
      ? includePath
      : `lib/${includePath}`;
    return resolveIncludes(resolved, seen);
  });
}

export type Defines = Record<string, string | number | boolean | undefined>;

function defineBlock(defines: Defines | undefined): string {
  if (!defines) return '';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(defines)) {
    if (value === undefined || value === false) continue;
    lines.push(value === true ? `#define ${key}` : `#define ${key} ${value}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

const VERSION = '#version 300 es\n';

/**
 * GLSL ES 3.00 gives float and int a default precision in the vertex stage but
 * *not* the array/3D/shadow sampler types — those have to be declared in every
 * stage that mentions them, vertex included.
 */
const PRECISION_COMMON =
  'precision highp sampler2DArray;\n' +
  'precision highp sampler3D;\n' +
  'precision highp sampler2DShadow;\n' +
  'precision highp sampler2DArrayShadow;\n';

const PRECISION_VS = 'precision highp float;\nprecision highp int;\n' + PRECISION_COMMON;

/**
 * Fragment shaders have no default precision at all, so float and int are
 * declared here too. highp is needed for depth reconstruction and world-space
 * positions, which is most of what this renderer does per pixel.
 */
const PRECISION_FS =
  'precision highp float;\nprecision highp int;\n' + PRECISION_COMMON;

function assemble(name: string, stage: 'vs' | 'fs', defines: Defines | undefined): string {
  const body = resolveIncludes(name, new Set());
  return VERSION + (stage === 'vs' ? PRECISION_VS : PRECISION_FS) + defineBlock(defines) + body;
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Не удалось создать шейдер: ${label}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function formatShaderError(source: string, log: string, label: string): string {
  // Driver logs are "0:LINE: message"; quote the offending lines with context
  // so a typo does not turn into a hunt through a 400-line assembled shader.
  const lines = source.split('\n');
  const out: string[] = [`Ошибка компиляции шейдера «${label}»:`, log.trim()];
  const seen = new Set<number>();
  for (const match of log.matchAll(/\b\d+:(\d+)\b/g)) {
    const line = Number(match[1]);
    if (seen.has(line)) continue;
    seen.add(line);
    const from = Math.max(1, line - 3);
    const to = Math.min(lines.length, line + 3);
    out.push('');
    for (let i = from; i <= to; i++) {
      out.push(`${i === line ? '>' : ' '} ${String(i).padStart(4)} | ${lines[i - 1]}`);
    }
  }
  return out.join('\n');
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly blocks = new Map<string, number>();
  private vs: WebGLShader | null;
  private fs: WebGLShader | null;
  private vsSource: string;
  private fsSource: string;
  private linked = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly label: string,
    vertexName: string,
    fragmentName: string,
    defines?: Defines,
  ) {
    this.vsSource = assemble(vertexName, 'vs', defines);
    this.fsSource = assemble(fragmentName, 'fs', defines);

    this.vs = compile(gl, gl.VERTEX_SHADER, this.vsSource, `${label}:vs`);
    this.fs = compile(gl, gl.FRAGMENT_SHADER, this.fsSource, `${label}:fs`);

    const program = gl.createProgram();
    if (!program) throw new Error(`Не удалось создать программу: ${label}`);
    this.handle = program;
    gl.attachShader(program, this.vs);
    gl.attachShader(program, this.fs);
    gl.linkProgram(program);
  }

  /**
   * True once the driver is done. With KHR_parallel_shader_compile this lets
   * the loader link every program at once instead of stalling on each in turn.
   */
  isReady(completionExt: { COMPLETION_STATUS_KHR: number } | null): boolean {
    if (this.linked) return true;
    if (!completionExt) return true;
    return this.gl.getProgramParameter(this.handle, completionExt.COMPLETION_STATUS_KHR) === true;
  }

  /** Validates link status and frees the shader objects. Throws on failure. */
  finish(): this {
    if (this.linked) return this;
    const gl = this.gl;

    if (!gl.getProgramParameter(this.handle, gl.LINK_STATUS)) {
      const programLog = gl.getProgramInfoLog(this.handle) ?? '';
      // A link failure is usually a compile failure; report whichever stage broke.
      if (this.vs && !gl.getShaderParameter(this.vs, gl.COMPILE_STATUS)) {
        throw new Error(
          formatShaderError(this.vsSource, gl.getShaderInfoLog(this.vs) ?? '', `${this.label}:vs`),
        );
      }
      if (this.fs && !gl.getShaderParameter(this.fs, gl.COMPILE_STATUS)) {
        throw new Error(
          formatShaderError(this.fsSource, gl.getShaderInfoLog(this.fs) ?? '', `${this.label}:fs`),
        );
      }
      throw new Error(`Ошибка линковки программы «${this.label}»:\n${programLog}`);
    }

    if (this.vs) {
      gl.detachShader(this.handle, this.vs);
      gl.deleteShader(this.vs);
      this.vs = null;
    }
    if (this.fs) {
      gl.detachShader(this.handle, this.fs);
      gl.deleteShader(this.fs);
      this.fs = null;
    }
    // Sources are kept only for error reporting; release them after linking.
    this.vsSource = '';
    this.fsSource = '';
    this.linked = true;
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    let location = this.uniforms.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name);
      this.uniforms.set(name, location);
    }
    return location;
  }

  /** Binds a uniform block to a binding point, caching the block index. */
  bindBlock(name: string, binding: number): void {
    let index = this.blocks.get(name);
    if (index === undefined) {
      index = this.gl.getUniformBlockIndex(this.handle, name);
      this.blocks.set(name, index);
    }
    if (index !== this.gl.INVALID_INDEX) {
      this.gl.uniformBlockBinding(this.handle, index, binding);
    }
  }

  // --- uniform setters (no-op when the uniform was optimised out) ---

  int(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }

  float(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }

  vec2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }

  vec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }

  vec3v(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v);
  }

  vec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }

  vec4v(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, v);
  }

  mat4(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, v);
  }

  floatArray(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, v);
  }

  vec4Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, v);
  }

  mat4Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, v);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}

/**
 * Compiles a batch of programs concurrently where the driver supports it, then
 * validates them all. Cuts cold-start link time roughly in half on Intel.
 */
export class ProgramCache {
  private readonly programs = new Map<string, Program>();
  private readonly pending: Program[] = [];
  private readonly completionExt: { COMPLETION_STATUS_KHR: number } | null;

  constructor(private readonly gl: WebGL2RenderingContext, parallelCompile: boolean) {
    this.completionExt = parallelCompile
      ? (gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null)
      : null;
  }

  /** Starts compiling; the returned Program is not usable until `flush()`. */
  create(label: string, vertexName: string, fragmentName: string, defines?: Defines): Program {
    const program = new Program(this.gl, label, vertexName, fragmentName, defines);
    this.programs.set(label, program);
    this.pending.push(program);
    return program;
  }

  get(label: string): Program {
    const program = this.programs.get(label);
    if (!program) throw new Error(`Программа не зарегистрирована: ${label}`);
    return program;
  }

  /** Returns true once every queued program has linked successfully. */
  poll(): boolean {
    while (this.pending.length > 0) {
      const program = this.pending[0];
      if (!program.isReady(this.completionExt)) return false;
      program.finish();
      this.pending.shift();
    }
    return true;
  }

  /** Blocking variant for call sites that cannot yield. */
  flush(): void {
    for (const program of this.pending) program.finish();
    this.pending.length = 0;
  }

  dispose(): void {
    for (const program of this.programs.values()) program.dispose();
    this.programs.clear();
    this.pending.length = 0;
  }
}
