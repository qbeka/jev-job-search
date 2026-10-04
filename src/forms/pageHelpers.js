// Runs inside the page through the fill runner (src/browser/formRunner.ts).
// Installs window.__awj: small read-only helpers plus the two writes the
// runner cannot do with real input events. Nothing here is page-supplied code.
(() => {
  const q = (s) => document.querySelector(s);
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // The words of an element. An icon's fallback text ("SVGs not supported by this browser.") is not one of them.
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/SVGs? not supported by this browser\.?/gi, "").replace(/\s+/g, " ").trim() : "");
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const center = (el) => {
    // Instant: a page with smooth scrolling would otherwise report the position before the scroll.
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 };
  };
  // Only a dropdown's own frame counts: a looser match would land clicks on some unrelated wrapper.
  const control = (el) => {
    if (el.getAttribute("role") !== "combobox") return el;
    const frame = el.closest('[class*="select__control"], [class$="-control"]');
    if (frame) return frame;
    // A search box that is only drawn while its list is open: the closed dropdown around it is what gets clicked.
    const r = el.getBoundingClientRect();
    return (r.width === 0 || r.height === 0) && el.closest('[data-testid="select-controller"]') ? el.closest('[data-testid="select-controller"]') : el;
  };
  // The list a picker opens: named by aria-controls or aria-owns, or by the menu id a button carries (BambooHR).
  const listRootOf = (el) => {
    const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || el.getAttribute("data-menu-id");
    return listId ? document.getElementById(listId) : null;
  };
  // Workday's search-and-pick box: a search input, the list of what is picked, and a list drawn elsewhere on the page.
  const PROMPT = '[data-automation-id="multiSelectContainer"]';
  const outermost = (rows) => rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)));
  const pickedIn = (prompt) => outermost([...prompt.querySelectorAll('[data-automation-id="selectedItemList"] [role=option], [data-automation-id="selectedItem"]')]).map(text).filter(Boolean).join(", ");
  const optionEls = (sel) => {
    const el = q(sel);
    if (!el) return [];
    const prompt = el.closest(PROMPT);
    // Its open list is drawn apart from the box. What is already picked, in this box or another, is not on offer.
    if (prompt) return [...document.querySelectorAll('[data-automation-id="activeListContainer"] [role=option]')].filter((o) => visible(o) && !o.closest(PROMPT));
    let root = listRootOf(el);
    if (!root) {
      const wrap = el.closest('[class*="container"], [class*="select"], [class*="field"], [class*="question"]');
      root = wrap ? wrap.querySelector('[role=listbox], [class*="menu"]') : null;
    }
    if (!root) {
      // A plain input with a suggestion list beside it: its rows are the options.
      const box = el.parentElement && el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i] ul, [class*="typeahead" i] ul, [class*="suggestions" i]');
      if (box) return [...box.children].filter(visible);
    }
    if (!root) {
      // A list the page draws from a <datalist> beside the input.
      const list = el.parentElement && el.parentElement.querySelector("datalist, [role=listbox]");
      if (list) return [...list.querySelectorAll("option, [role=option]")].filter(visible);
    }
    if (!root && el.getAttribute("aria-expanded") !== "true") return [];
    const all = root ? [...root.querySelectorAll(root.tagName === "DATALIST" ? "option, [role=option]" : "[role=option], [role=menuitem]")] : [...document.querySelectorAll("[role=option]")].filter((o) => !o.closest(".iti") && !o.closest(PROMPT));
    return all.filter(visible);
  };
  // Dropdown components keep their option list and their select handler on their own props.
  // Reading them is instant and needs no clicking. Two shapes are known:
  //   "select": react-select (Greenhouse). options + selectOption, and loadOptions when the list is lazy.
  //   "search": a search box with results (Ashby schools and locations). onSearch + results + onSelect.
  // For anything else these return null and the runner opens the dropdown with real clicks.
  const adapter = (el) => {
    const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    if (!f) return null;
    // The node may hold the previous render's fiber; the live tree is the one its root points at.
    let top = f;
    while (top.return) top = top.return;
    if (top.stateNode && top.stateNode.current && top.stateNode.current !== top && f.alternate) f = f.alternate;
    for (let i = 0; f && i < 12; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (typeof p.selectOption === "function" && Array.isArray(p.options)) return { shape: "select", p };
      if (typeof p.onSelect === "function" && typeof p.onSearch === "function") return { shape: "search", p };
    }
    return null;
  };
  const loaded = {};
  const flat = (options) => options.flatMap((o) => (o && Array.isArray(o.options) ? o.options : [o]));
  const labelOf = (a, o) => {
    const get = a.shape === "select" && a.p.selectProps && a.p.selectProps.getOptionLabel;
    const l = typeof get === "function" ? get(o) : o.label;
    return String(typeof l === "string" || typeof l === "number" ? l : o.label ?? o.name ?? o.placeName ?? o.title ?? o.value ?? "").replace(/\s+/g, " ").trim();
  };
  const optionsOf = (a) => (a.shape === "select" ? flat(a.p.options) : a.p.results || []);
  window.__awj = {
    /** Option labels straight from the component, or null when the control is not one of the known shapes. */
    reactOptions(sel) {
      const a = adapter(q(sel));
      return a ? optionsOf(a).map((o) => labelOf(a, o)) : null;
    },
    /** Starts a search in a search-as-you-type dropdown without touching the keyboard. */
    reactSearch(sel, typed) {
      const a = adapter(q(sel));
      if (!a) return false;
      if (a.shape === "search") {
        a.p.onSearch(typed);
        return true;
      }
      const onInput = a.p.selectProps && a.p.selectProps.onInputChange;
      if (typeof onInput !== "function") return false;
      onInput(typed, { action: "input-change", prevInputValue: "" });
      if (!typed && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Opens or closes a react-select's menu through its own handlers, which is what makes a lazy list load. */
    reactMenu(sel, open) {
      const a = adapter(q(sel));
      const fn = a && a.shape === "select" && a.p.selectProps && (open ? a.p.selectProps.onMenuOpen : a.p.selectProps.onMenuClose);
      if (typeof fn !== "function") return false;
      fn();
      return true;
    },
    /**
     * Asks a paginated or lazy select for its options through its own loader, with a search text.
     * Returns the labels, or null when the control has no loader. The option objects are kept for reactSelect.
     */
    async reactLoad(sel, search) {
      const a = adapter(q(sel));
      const load = a && a.shape === "select" && a.p.selectProps && a.p.selectProps.loadOptions;
      if (typeof load !== "function") return null;
      const res = await load(search, [], a.p.selectProps.additional);
      const options = flat(Array.isArray(res) ? res : (res && res.options) || []);
      loaded[sel] = options;
      return options.map((o) => labelOf(a, o));
    },
    reactSelect(sel, label) {
      const a = adapter(q(sel));
      if (!a) return false;
      const o = optionsOf(a).find((x) => labelOf(a, x) === label) || (loaded[sel] || []).find((x) => labelOf(a, x) === label);
      if (!o) return false;
      if (a.shape === "search") {
        a.p.onSelect(o);
        return true;
      }
      a.p.selectOption(o);
      if (a.p.selectProps && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Centre of the control to click, after scrolling it into view. */
    point(sel) {
      const el = q(sel);
      return el && visible(control(el)) ? center(control(el)) : { x: 0, y: 0, ok: false };
    },
    /**
     * "on" for a control that can take a value, "off" for one the form has hidden or disabled
     * (usually because of another answer), "missing" when the selector no longer finds anything.
     */
    state(sel) {
      const el = q(sel);
      if (!el) return "missing";
      // A box drawn by its label counts as there when the label is.
      const label = (el.type === "radio" || el.type === "checkbox") && (el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("[role=checkbox]"));
      // A select drawn by select2 counts as there when the box beside it is.
      const select2 = el.tagName === "SELECT" && /select2-hidden/.test(el.className) && el.nextElementSibling;
      return !el.disabled && (el.type === "file" || visible(el) || visible(control(el)) || (label && visible(label)) || (select2 && visible(select2))) ? "on" : "off";
    },
    /** True when keyboard input would land in this control right now. */
    hasFocus(sel) {
      const el = q(sel);
      if (!el) return false;
      // A menu that opened with its own search box took the keyboard on purpose: typing goes to the list.
      const list = listRootOf(el);
      return document.activeElement === el || el.contains(document.activeElement) || (!!list && list.contains(document.activeElement));
    },
    /** Puts the keyboard in a text box. False for anything that is not one, or that would not take it. */
    focus(sel) {
      const el = q(sel);
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
      el.focus();
      return document.activeElement === el;
    },
    selectAll() {
      const a = document.activeElement;
      if (a && typeof a.select === "function") a.select();
    },
    options(sel) {
      return optionEls(sel).map(text);
    },
    /** Why a control that is in the page cannot be seen, and any dialog lying over the page, for the trace. No value is read. */
    whyHidden(sel) {
      const el = q(sel);
      const line = (n) => [n.tagName.toLowerCase(), n.getAttribute("role") || "", n.getAttribute("data-automation-id") || "", n.id ? `#${n.id}` : ""].filter(Boolean).join(" ");
      const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal="true"], [data-automation-id*="popup" i]')].filter(visible).slice(0, 2).map((n) => `${line(n)}: "${text(n).slice(0, 160)}"`);
      let why = "not in the page";
      if (el) {
        why = "seen";
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const st = getComputedStyle(n);
          const r = n.getBoundingClientRect();
          if (st.display === "none" || st.visibility === "hidden" || r.width === 0 || r.height === 0) why = `hidden at ${line(n)} (display ${st.display}, visibility ${st.visibility}, ${Math.round(r.width)}x${Math.round(r.height)})`;
        }
      }
      return `${why}${dialogs.length ? `; over the page: ${dialogs.join(" | ")}` : ""}; url ${location.pathname.slice(-60)}`;
    },
    /** True for a box that only searches once Enter is pressed (Workday's search-and-pick box). */
    searchesOnEnter(sel) {
      const el = q(sel);
      return !!el && !!el.closest(PROMPT);
    },
    /**
     * The shape of a control and of any list open on the page, for the trace of a value that did
     * not land: tags, roles and the site's own names for its parts. No value of any box is read.
     */
    sketch(sel) {
      const el = q(sel);
      if (!el) return "not on the page";
      const line = (n) => {
        const bits = [n.tagName.toLowerCase()];
        for (const a of ["role", "data-automation-id", "data-uxi-widget-type", "aria-haspopup", "aria-expanded", "aria-controls", "aria-checked", "aria-selected"]) if (n.hasAttribute(a)) bits.push(`${a}=${n.getAttribute(a)}`);
        return bits.join(" ");
      };
      const named = (root, most) => [root, ...root.querySelectorAll("[role], [data-automation-id]")].filter(visible).slice(0, most).map((n) => `${line(n)}${n.matches("[role=option], [data-automation-id^=prompt], [data-automation-id=menuItem]") ? ` "${text(n).slice(0, 40)}"` : ""}`);
      let box = el;
      for (let i = 0; i < 3 && box.parentElement && !box.matches("[data-automation-id^=formField]"); i++) box = box.parentElement;
      const lists = [...document.querySelectorAll('[role=listbox], [data-automation-id="activeListContainer"], [data-automation-widget="wd-popup"], [data-automation-id*="popup" i]')].filter((n) => visible(n) && !box.contains(n));
      return [`control: ${named(box, 20).join(" > ")}`, ...outermost(lists).slice(0, 2).map((l) => `open list: ${named(l, 30).join(" > ")}`)].join(" || ");
    },
    optionPoint(sel, label) {
      const o = optionEls(sel).find((x) => text(x) === label);
      if (!o) return { x: 0, y: 0, ok: false };
      const p = center(o);
      // A list still moving under the pointer would take the click on the row beside this one. The point counts only when this row is what lies under it.
      const under = p.ok ? document.elementFromPoint(p.x, p.y) : null;
      return { ...p, ok: !!under && (o.contains(under) || under.contains(o)) };
    },
    /**
     * The calendar that belongs to a date box, as the runner needs it to click through: whether it
     * is open, the month it shows, where its two arrows are, and where each day of that month is.
     */
    calendar(sel) {
      const closed = { open: false, heading: "", prev: { x: 0, y: 0, ok: false }, next: { x: 0, y: 0, ok: false }, days: [] };
      const el = q(sel);
      if (!el) return closed;
      const PICKER = '[class*="date-picker" i], [class*="datepicker" i], [class*="calendar" i], [role=dialog], [role=grid]';
      const item = el.closest("[variant], [class*=form-item i], [class*=field i]") || el.parentElement;
      // The pop-up sits in the field itself, or the page draws it at the end of the document.
      const isDay = (n) => /^\d{1,2}$/.test(text(n));
      // A calendar is whatever holds a week or more of day numbers. A calendar icon matches the same words and holds none.
      const holdsDays = (p) => p instanceof HTMLElement && visible(p) && [...p.querySelectorAll("button, td, [role=gridcell]")].filter((n) => visible(n) && isDay(n)).length >= 7;
      const near = item ? [...item.querySelectorAll(PICKER)].filter(holdsDays) : [];
      const anywhere = near.length ? near : [...document.querySelectorAll(PICKER)].filter(holdsDays);
      const pop = anywhere.find((p) => !anywhere.some((o) => o !== p && o.contains(p)));
      if (!pop) return closed;
      const MONTH = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,]+\d{4}|\d{4}[\s,]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
      const OUTSIDE = /not-this-month|outside|other-month|adjacent|prev-month|next-month|disabled|muted/i;
      const cells = [...pop.querySelectorAll('button, td, [role=gridcell], [class*="day" i]')].filter((n) => visible(n) && isDay(n) && !n.querySelector('button, td, [role=gridcell]'));
      const days = cells.filter((n) => !OUTSIDE.test(String(n.getAttribute("class") || "")) && n.getAttribute("aria-disabled") !== "true" && !n.disabled);
      if (!cells.length) return closed;
      const first = cells[0];
      const headingEl = [...pop.querySelectorAll("*")].find((n) => n.children.length === 0 && MONTH.test(text(n)) && text(n).length < 30 && (n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
      // Pickers with a month list and a year box have no single heading: their header's text is read whole.
      const selects = [...pop.querySelectorAll("select")].filter(visible).map((s2) => text(s2.selectedOptions[0]));
      const yearBox = [...pop.querySelectorAll('input[type=number], input[class*="year" i]')].filter(visible).map((i) => i.value);
      const heading = headingEl ? text(headingEl) : [...selects, ...yearBox].join(" ");
      // The arrows are the buttons above the days that are not days. By name when they are named, else first and last.
      const arrows = [...pop.querySelectorAll('button, [role=button], a, [class*="nav" i], [class*="arrow" i]')].filter((n) => visible(n) && !isDay(n) && !cells.includes(n) && (n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
      const named = (re) => arrows.find((n) => re.test(`${n.getAttribute("aria-label") || ""} ${n.getAttribute("class") || ""} ${n.title || ""}`));
      const prev = named(/prev|back|earlier|left/i) || arrows[0];
      const next = named(/next|forward|later|right/i) || arrows[arrows.length - 1];
      // The pop-up is brought into view once, and every point is then read without scrolling again:
      // points read at different scroll positions would not belong to the same picture.
      pop.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const at = (n) => {
        if (!n) return { x: 0, y: 0, ok: false };
        const r = n.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight };
      };
      return { open: true, heading, prev: at(prev), next: prev === next ? { x: 0, y: 0, ok: false } : at(next), days: days.map((n) => ({ day: Number(text(n)), ...at(n) })).filter((d) => d.ok) };
    },
    /** Centre of one choice in a button group or a drawn radio row, for a real click. */
    groupOptionPoint(sel, label) {
      const el = q(sel);
      if (!el) return { x: 0, y: 0, ok: false };
      const want = label.toLowerCase().trim();
      const o = [...el.querySelectorAll("button, [role=radio], [role=option], label")].find((x) => visible(x) && text(x).toLowerCase() === want);
      return o ? center(o) : { x: 0, y: 0, ok: false };
    },
    /** What the control shows as its current value. */
    shown(sel) {
      const el = q(sel);
      if (!el) return "";
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.type === "radio" && el.name) {
          const on = [...document.querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`)].find((r) => r.checked);
          return on ? text(on.closest("label") || (on.id && document.querySelector(`label[for="${CSS.escape(on.id)}"]`)) || on.parentElement) || on.value : "";
        }
        return el.checked ? "checked" : "";
      }
      if (el.type === "file") {
        const wrap = el.closest('[class*="field"], [class*="upload"], [class*="file"], fieldset, div');
        return el.files && el.files.length ? el.files[0].name : /\.pdf/i.test(text(wrap)) ? text(wrap).slice(0, 80) : "";
      }
      if (el.tagName === "SELECT") return el.selectedOptions[0] && el.value !== "" ? text(el.selectedOptions[0]) : "";
      // A search-and-pick box shows what is picked beside a search input that stays empty.
      if (el.closest(PROMPT)) return pickedIn(el.closest(PROMPT));
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && (el.getAttribute("role") === "combobox" || el.hasAttribute("aria-haspopup"))) {
        // A dropdown drawn without an input shows its value as its own text, or a placeholder when empty.
        const t = text(el);
        return /^[-–—\s]*(select|select\.\.\.|select an option|select one|choose|search|please select)?[-–—\s]*$/i.test(t) ? "" : t;
      }
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
        // A button group: the pressed button's text.
        const on = [...el.querySelectorAll("button, [role=radio], [role=option]")].find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked");
        return on ? text(on) : "";
      }
      if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") {
        const a = adapter(el);
        if (a && a.shape === "select" && typeof a.p.getValue === "function") return a.p.getValue().map((o) => labelOf(a, o)).join(", ");
        if (a && a.shape === "search") return a.p.selectedItemText || el.value || "";
        // Selectize keeps the picks as items beside an input that stays empty.
        const selectize = el.closest(".selectize-input");
        if (selectize) return [...selectize.querySelectorAll(".item")].map(text).join(", ") || el.value || "";
        const c = control(el);
        const single = c.querySelector('[class*="single-value"], [class*="singleValue"]');
        const multi = [...c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue"]')].map(text).join(", ");
        return single ? text(single) : multi || el.value || "";
      }
      return el.value || "";
    },
    /** True when the page shows this file name, which is how an accepted upload looks once the input is replaced. */
    showsFile(name) {
      return (document.body.innerText || "").includes(name) || [...document.querySelectorAll("input[type=file]")].some((i) => i.files && [...i.files].some((f) => f.name === name));
    },
    blur() {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    },
    errors() {
      return [...document.querySelectorAll('[aria-invalid="true"], [class*="error" i]')].filter(visible).map(text).filter((t) => t && t.length < 200).slice(0, 20);
    },
    pageText() {
      return document.body ? document.body.innerText : "";
    },
    controlCount() {
      return document.readyState !== "loading" ? document.querySelectorAll("input, select, textarea").length : -1;
    },
    /** What lies over a control at the point a click would land: empty when nothing does, else the words of the thing in the way (a cookie banner, a chat bubble). */
    coveredBy(sel) {
      const el = q(sel);
      if (!el) return "";
      const p = center(el);
      const top = document.elementFromPoint(p.x, p.y);
      if (!top || el.contains(top) || top.contains(el)) return "";
      // Workday lays a clickable sheet over its buttons: the sheet is the button, and a click on it is a click on the control.
      if (top.getAttribute("data-automation-id") === "click_filter" && top.parentElement === el.parentElement) return "";
      let box = top;
      while (box.parentElement && box.parentElement !== document.body && text(box).length < 40) box = box.parentElement;
      return text(box).slice(0, 200) || top.tagName;
    },
    /** Clicks a control from script, for the case where something lies over it and a real click cannot reach it. */
    press(sel) {
      const el = q(sel);
      if (!el) return false;
      el.click();
      return true;
    },
    clickByText(pattern) {
      const re = new RegExp(pattern, "i");
      const b = [...document.querySelectorAll("a, button, [role=button]")].find((x) => visible(x) && re.test(text(x)));
      if (!b) return { x: 0, y: 0, ok: false };
      // Where the button leads, when it is a plain link to another page.
      const a = b.closest("a[href]");
      const href = a && /^https?:/.test(a.href) && a.href.split("#")[0] !== location.href.split("#")[0] ? a.href : undefined;
      return { ...center(b), href };
    },
  };
  return "ok";
})();
