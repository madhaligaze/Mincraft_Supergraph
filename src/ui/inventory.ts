/**
 * The inventory window.
 *
 * Plain DOM, like the rest of the interface: it costs no frame time, it scales
 * with the display, and the renderer stays free of text layout. What it must
 * get right is the *grammar* of the reference window — left-click swaps, right-
 * click splits, shift-click sends a stack across — because that grammar is
 * older than most of the people who will use it and any deviation reads as a
 * bug.
 *
 * The world keeps running behind it. That is deliberate: in the reference,
 * rummaging in your bag does not pause the sun, and pausing it here would make
 * the crafting screen a safe room.
 */

import { Inventory, CraftGrid, HOTBAR_SIZE, INVENTORY_SIZE, type Slot } from '../game/inventory.ts';
import { matchRecipe } from '../game/recipes.ts';
import { itemDef, maxStack, sameItem, stack, type ItemStack } from '../game/items.ts';
import type { IconSet } from './icons.ts';

export interface InventoryCallbacks {
  /** Something left the window and belongs on the ground. */
  onDrop(item: ItemStack): void;
  /** The window opened or closed; the game releases the pointer for it. */
  onVisibility(open: boolean): void;
}

/** Where a click landed. The grid and the bag share one interaction routine. */
type Target =
  | { kind: 'inventory'; index: number }
  | { kind: 'craft'; index: number }
  | { kind: 'result' };

export class InventoryWindow {
  private readonly root: HTMLElement;
  private readonly craftEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private readonly storageEl: HTMLElement;
  private readonly hotbarEl: HTMLElement;
  private readonly cursorEl: HTMLElement;
  private readonly titleEl: HTMLElement;

  private craftSlots: HTMLElement[] = [];
  private storageSlots: HTMLElement[] = [];
  private hotbarSlots: HTMLElement[] = [];

  readonly grid = new CraftGrid(2);

  private open = false;
  private lastVersion = -1;
  private lastGridStamp = '';

  constructor(
    private readonly inventory: Inventory,
    private readonly icons: IconSet,
    private readonly callbacks: InventoryCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'inventory';
    this.root.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'inv-panel';
    this.root.appendChild(panel);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'inv-title';
    panel.appendChild(this.titleEl);

    const top = document.createElement('div');
    top.className = 'inv-top';
    panel.appendChild(top);

    this.craftEl = document.createElement('div');
    this.craftEl.className = 'inv-craft';
    top.appendChild(this.craftEl);

    const arrow = document.createElement('div');
    arrow.className = 'inv-arrow';
    arrow.textContent = '→';
    top.appendChild(arrow);

    this.resultEl = document.createElement('div');
    this.resultEl.className = 'islot result';
    top.appendChild(this.resultEl);

    this.storageEl = document.createElement('div');
    this.storageEl.className = 'inv-grid';
    panel.appendChild(this.storageEl);

    this.hotbarEl = document.createElement('div');
    this.hotbarEl.className = 'inv-grid inv-hotbar-row';
    panel.appendChild(this.hotbarEl);

    const hint = document.createElement('div');
    hint.className = 'inv-hint';
    hint.textContent =
      'ЛКМ взять · ПКМ половину · Shift+ЛКМ переложить · Q выбросить · E закрыть';
    panel.appendChild(hint);

    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'inv-cursor';
    this.cursorEl.hidden = true;
    this.root.appendChild(this.cursorEl);

    document.body.appendChild(this.root);

    this.build();

    // Clicking the dark surround throws what is on the cursor away, exactly
    // like the reference — and is also the only way to close by mouse.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target !== this.root) return;
      this.spillCursor();
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', this.onMouseMove);
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.open) return;
    this.cursorEl.style.left = `${e.clientX}px`;
    this.cursorEl.style.top = `${e.clientY}px`;
  };

  private build(): void {
    this.buildCraft();

    this.storageEl.textContent = '';
    this.storageSlots = [];
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) {
      const slot = this.makeSlot({ kind: 'inventory', index: i });
      this.storageEl.appendChild(slot);
      this.storageSlots.push(slot);
    }

    this.hotbarEl.textContent = '';
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = this.makeSlot({ kind: 'inventory', index: i });
      this.hotbarEl.appendChild(slot);
      this.hotbarSlots.push(slot);
    }

    this.bindSlot(this.resultEl, { kind: 'result' });
  }

  private buildCraft(): void {
    this.craftEl.textContent = '';
    this.craftEl.style.gridTemplateColumns = `repeat(${this.grid.size}, 1fr)`;
    this.craftSlots = [];
    for (let i = 0; i < this.grid.size * this.grid.size; i++) {
      const slot = this.makeSlot({ kind: 'craft', index: i });
      this.craftEl.appendChild(slot);
      this.craftSlots.push(slot);
    }
  }

  private makeSlot(target: Target): HTMLElement {
    const el = document.createElement('div');
    el.className = 'islot';
    this.bindSlot(el, target);
    return el;
  }

  private bindSlot(el: HTMLElement, target: Target): void {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.click(target, e.button, e.shiftKey);
    });
  }

  // --- interaction ---------------------------------------------------------

  private click(target: Target, button: number, shift: boolean): void {
    if (target.kind === 'result') {
      this.takeResult(shift);
      this.refresh(true);
      return;
    }

    if (target.kind === 'inventory') {
      if (shift && button === 0) this.inventory.quickMove(target.index);
      else if (button === 2) this.inventory.rightClickSlot(target.index);
      else this.inventory.clickSlot(target.index);
      this.refresh(true);
      return;
    }

    // Crafting cell: the same swap-or-merge rules, on a grid the inventory does
    // not own.
    const cell = this.grid.get(target.index);
    const cursor = this.inventory.cursor;

    if (shift && button === 0 && cell) {
      const left = this.inventory.add(cell);
      this.grid.set(target.index, left > 0 ? stack(cell.id, left, cell.damage) : null);
      this.refresh(true);
      return;
    }

    if (button === 2) {
      if (!cursor) {
        if (cell) {
          const half = Math.ceil(cell.count / 2);
          this.inventory.cursor = stack(cell.id, half, cell.damage);
          cell.count -= half;
          this.grid.set(target.index, cell.count > 0 ? cell : null);
        }
      } else if (!cell) {
        this.grid.set(target.index, stack(cursor.id, 1, cursor.damage));
        cursor.count--;
        if (cursor.count <= 0) this.inventory.cursor = null;
      } else if (sameItem(cell, cursor) && cell.count < maxStack(cell.id)) {
        cell.count++;
        cursor.count--;
        if (cursor.count <= 0) this.inventory.cursor = null;
      }
      this.refresh(true);
      return;
    }

    if (cursor && cell && sameItem(cursor, cell)) {
      const limit = maxStack(cell.id);
      const moved = Math.min(limit - cell.count, cursor.count);
      cell.count += moved;
      cursor.count -= moved;
      if (cursor.count <= 0) this.inventory.cursor = null;
    } else {
      this.grid.set(target.index, cursor);
      this.inventory.cursor = cell;
    }
    this.refresh(true);
  }

  /**
   * Takes what the grid makes.
   *
   * Shift-click crafts as many as the ingredients allow and sends them straight
   * to the bag — the difference between making one plank and making a stack is
   * thirty clicks, and nobody makes one plank.
   */
  private takeResult(shift: boolean): void {
    const result = matchRecipe(this.grid.cells, this.grid.size);
    if (!result) return;

    if (shift) {
      let guard = 0;
      while (guard++ < 64) {
        const next = matchRecipe(this.grid.cells, this.grid.size);
        if (!next) break;
        if (!this.inventory.canFit(next)) break;
        this.inventory.add(next);
        this.grid.consumeOne();
      }
      return;
    }

    const cursor = this.inventory.cursor;
    if (cursor) {
      if (!sameItem(cursor, result)) return;
      if (cursor.count + result.count > maxStack(result.id)) return;
      cursor.count += result.count;
    } else {
      this.inventory.cursor = result;
    }
    this.grid.consumeOne();
  }

  /** Puts the cursor stack back in the bag, or on the ground if it will not fit. */
  private spillCursor(): void {
    const cursor = this.inventory.cursor;
    if (!cursor) return;
    this.inventory.cursor = null;
    const left = this.inventory.add(cursor);
    if (left > 0) this.callbacks.onDrop(stack(cursor.id, left, cursor.damage));
    this.refresh(true);
  }

  // --- visibility ----------------------------------------------------------

  get isOpen(): boolean {
    return this.open;
  }

  /** `size` is 2 for the player's own grid and 3 for a crafting table. */
  show(size: number, title: string): void {
    if (this.grid.size !== size) {
      this.grid.resize(size);
      this.buildCraft();
    }
    this.titleEl.textContent = title;
    this.open = true;
    this.root.hidden = false;
    this.refresh(true);
    this.callbacks.onVisibility(true);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;

    // Nothing may stay behind in the grid or on the cursor: an item the player
    // cannot see is an item they have lost.
    for (const spilled of this.grid.returnTo(this.inventory)) this.callbacks.onDrop(spilled);
    const cursor = this.inventory.cursor;
    if (cursor) {
      this.inventory.cursor = null;
      const left = this.inventory.add(cursor);
      if (left > 0) this.callbacks.onDrop(stack(cursor.id, left, cursor.damage));
    }

    this.callbacks.onVisibility(false);
  }

  toggle(size: number, title: string): void {
    if (this.open) this.hide(); else this.show(size, title);
  }

  // --- painting ------------------------------------------------------------

  /**
   * Redraws, but only when something changed.
   *
   * Forty-odd slots is not much, but this is called every frame from the loop,
   * and rebuilding forty DOM subtrees at sixty hertz is exactly the sort of
   * thing that shows up as a stutter while mining.
   */
  refresh(force = false): void {
    if (!this.open) return;
    const stamp = this.gridStamp();
    if (!force && this.inventory.version === this.lastVersion && stamp === this.lastGridStamp) {
      return;
    }
    this.lastVersion = this.inventory.version;
    this.lastGridStamp = stamp;

    for (let i = 0; i < this.hotbarSlots.length; i++) {
      this.paint(this.hotbarSlots[i], this.inventory.get(i));
    }
    for (let i = 0; i < this.storageSlots.length; i++) {
      this.paint(this.storageSlots[i], this.inventory.get(HOTBAR_SIZE + i));
    }
    for (let i = 0; i < this.craftSlots.length; i++) {
      this.paint(this.craftSlots[i], this.grid.get(i));
    }
    this.paint(this.resultEl, matchRecipe(this.grid.cells, this.grid.size));

    const cursor = this.inventory.cursor;
    this.cursorEl.hidden = !cursor;
    if (cursor) this.paint(this.cursorEl, cursor);
  }

  private gridStamp(): string {
    let out = this.inventory.cursor
      ? `c${this.inventory.cursor.id}x${this.inventory.cursor.count}`
      : 'c-';
    for (const cell of this.grid.cells) out += cell ? `|${cell.id}x${cell.count}` : '|-';
    return out;
  }

  /** One slot. Icon, count, and a wear bar for a tool that has been used. */
  private paint(el: HTMLElement, item: Slot): void {
    el.textContent = '';
    el.classList.toggle('filled', !!item);
    if (!item) {
      el.title = '';
      return;
    }

    const def = itemDef(item.id);
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.style.backgroundImage = `url(${this.icons.urls[item.id] ?? ''})`;
    el.appendChild(icon);

    if (item.count > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(item.count);
      el.appendChild(count);
    }

    if (def.durability > 0 && item.damage > 0) {
      const bar = document.createElement('div');
      bar.className = 'wear';
      const left = 1 - item.damage / def.durability;
      bar.style.width = `${Math.max(0, left) * 100}%`;
      // Green through to red, the way every durability bar since 2011 reads.
      bar.style.background = `hsl(${Math.round(left * 110)}, 85%, 45%)`;
      el.appendChild(bar);
    }

    el.title = def.durability > 0
      ? `${def.label} — ${def.durability - item.damage} использований`
      : def.label;
  }
}
