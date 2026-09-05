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
    // F-keys and Tab would otherwise trigger browser chrome mid-game.
    if (this.locked && (e.code.startsWith('F') || e.code === 'Tab')) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  /** Losing focus must clear held keys or the player walks off on their own. */
  private onBlur = (): void => {
    this.down.clear();
    this.buttons = 0;
  };

  private onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.down.clear();
      this.buttons = 0;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    const bit = 1 << e.button;
    if (!(this.buttons & bit)) this.buttonsPressed |= bit;
    this.buttons |= bit;
  };

  private onMouseUp = (e: MouseEvent): void => {
    const bit = 1 << e.button;
    if (this.buttons & bit) this.buttonsReleased |= bit;
    this.buttons &= ~bit;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.locked) e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
  };

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
