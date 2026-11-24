// Obsidian ships declarations only; its runtime is supplied by the host app.
// Tests that exercise views must explicitly provide the host behavior they use.
export class ItemView {}
export class Notice {}
export const MarkdownRenderer = {};
export function setIcon(): void {}

/** Minimal settings row: records its texts and components; `settingEl` comes from the container's `createDiv`. */
export class Setting {
  name = '';
  desc = '';
  readonly components: Record<string, any>[] = [];
  readonly settingEl: any;
  constructor(containerEl: any) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.settingEl.setting = this;
  }
  setName(name: string): this { this.name = name; return this; }
  setDesc(desc: string): this { this.desc = desc; return this; }
  setHeading(): this { return this; }
  addText(build: (c: any) => void): this { return this.add({ inputEl: { type: 'text' } }, build); }
  addToggle(build: (c: any) => void): this { return this.add({}, build); }
  addButton(build: (c: any) => void): this {
    const buttonEl = { focused: false, focus() { buttonEl.focused = true; } };
    return this.add({ buttonEl }, build);
  }
  private add(component: Record<string, any>, build: (c: any) => void): this {
    const c: Record<string, any> = Object.assign(component, {
      value: undefined, text: '', cta: false, disabled: false, change: null, click: null,
      setValue(v: unknown) { c.value = v; return c; }, getValue: () => c.value, setPlaceholder: () => c,
      onChange(f: unknown) { c.change = f; return c; }, setButtonText(t: string) { c.text = t; return c; },
      setCta() { c.cta = true; return c; }, setDisabled(d: boolean) { c.disabled = d; return c; },
      onClick(f: unknown) { c.click = f; return c; },
    });
    this.components.push(c);
    build(c);
    return this;
  }
}
