/**
 * Keyboard + pointer-lock mouse input.
 *
 * Mouse deltas accumulate between frames and are drained by the consumer, so
 * a frame that takes 40 ms still gets every motion event the browser fired.
 */

export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly releasedThisFrame = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  /** Bit 0 = left, bit 1 = right, bit 2 = middle. */
  buttons = 0;
  private buttonsPressed = 0;
  private buttonsReleased = 0;

  locked = false;
  sensitivity = 0.0022;

  /**
   * Input is being driven by a script rather than by a person.
   *
   * Headless Chrome cannot grant pointer lock, so a test that clicks "Play"
   * immediately loses it again and the game pauses — which is why nothing that
   * needs the simulation to actually run could be tested from the outside. In
   * synthetic mode `locked` is forced true, real mouse and keyboard events are
   * ignored, and the deltas come from `inject*` instead.
   *
   * This is the difference between a screenshot rig and being able to play the
   * game from a script: walking, digging, building and swimming all need the
   * clock to advance.
   */
  synthetic = false;

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.synthetic) return;
    // F-keys and Tab would otherwise trigger browser chrome mid-game.
    if (this.locked && (e.code.startsWith('F') || e.code === 'Tab')) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.synthetic) return;
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  /** Losing focus must clear held keys or the player walks off on their own. */
  private onBlur = (): void => {
    if (this.synthetic) return;
    this.down.clear();
    this.buttons = 0;
  };

  private onPointerLockChange = (): void => {
    if (this.synthetic) return;
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.down.clear();
      this.buttons = 0;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.synthetic) return;
    const bit = 1 << e.button;
    if (!(this.buttons & bit)) this.buttonsPressed |= bit;
    this.buttons |= bit;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.synthetic) return;
    const bit = 1 << e.button;
    if (this.buttons & bit) this.buttonsReleased |= bit;
    this.buttons &= ~bit;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.synthetic || !this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.locked) e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
  };

  /** Switches to script-driven input and pretends the pointer is captured. */
  beginSynthetic(): void {
    this.synthetic = true;
    this.locked = true;
    this.down.clear();
    this.buttons = 0;
  }

  injectKey(code: string, down: boolean): void {
    if (down) {
      if (!this.down.has(code)) this.pressedThisFrame.add(code);
      this.down.add(code);
    } else {
      if (this.down.has(code)) this.releasedThisFrame.add(code);
      this.down.delete(code);
    }
  }

  injectMouse(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  injectButton(button: number, down: boolean): void {
    const bit = 1 << button;
    if (down) {
      if (!(this.buttons & bit)) this.buttonsPressed |= bit;
      this.buttons |= bit;
    } else {
      if (this.buttons & bit) this.buttonsReleased |= bit;
      this.buttons &= ~bit;
    }
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedThisFrame.has(code);
  }

  /** `button`: 0 left, 1 right, 2 middle. */
  isButtonDown(button: number): boolean {
    return (this.buttons & (1 << button)) !== 0;
  }

  wasButtonPressed(button: number): boolean {
    return (this.buttonsPressed & (1 << button)) !== 0;
  }

  wasButtonReleased(button: number): boolean {
    return (this.buttonsReleased & (1 << button)) !== 0;
  }

  /** Call once at the end of every frame, after all consumers have read. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.buttonsPressed = 0;
    this.buttonsReleased = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}
