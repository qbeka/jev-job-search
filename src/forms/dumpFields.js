// Runs inside the page through Claude in Chrome's javascript tool.
// Serializes every visible form control to JSON so JEV can map it.
// Returns a string: JSON.stringify(FieldsDump). No side effects.
(() => {
  // Password inputs are never dumped: a page that asks for one is a login or account page, not an application form.
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "search", "password"]);
  // Long enough for a question that follows a paragraph of legal text: the question is usually at the end.
  const LABEL_MAX = 700;
  const seenRadio = new Set();
  const fields = [];
  const out = { url: location.href, title: document.title, context: "", fields, submitSelectors: [] };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (el.type === "file") return true; // file inputs are routinely hidden behind a styled button
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // react-select and friends keep a transparent, focus-skipped input around for HTML5 validation.
    if (st.opacity === "0" && el.tabIndex === -1) return false;
    return true;
  };
  // The words of an element. An icon's fallback text ("SVGs not supported by this browser.") is not one of them.
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/SVGs? not supported by this browser\.?/gi, "").replace(/\s+/g, " ").trim() : "");
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1"));
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  // Ids a UI library numbers on each render (FabricTextField-349, :r1:, radix-12) can change under us, so they are not used to find a field again.
  // An id that merely ends in digits (question_8595663005, school--0) is the form's own and stays put.
  // A run of twelve or more letters and digits in both cases (nNpgf9k9eygQEJqI) is drawn at random on each render.
  const RENDER_ID = /^(:r|radix-|headlessui-|mui-|react-aria|downshift-|rc_select_|el-id-|Fabric[A-Za-z]*-?\d|field-\d+$|(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9]{12,}$)/;
  const stableId = (id) => !!id && !RENDER_ID.test(id) && unique("#" + cssEscape(id));
  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase();
    // A radio button is one of a group, and the group is what gets set: its name finds it again whatever its id.
    if (el.type === "radio" && el.name) return `${tag}[name="${attr(el.name)}"]`;
    if (stableId(el.id)) return "#" + cssEscape(el.id);
    // A name the site's own tests use for the control stays put across renders.
    for (const a of ["data-testid", "data-ui", "data-qa", "data-automation-id"]) {
      const v = el.getAttribute(a);
      if (v && unique(`${tag}[${a}="${attr(v)}"]`)) return `${tag}[${a}="${attr(v)}"]`;
    }
    // Next best: the nearest container the site names, when it holds exactly one control of this kind.
    for (let cur = el.parentElement, depth = 0; cur && depth < 6; cur = cur.parentElement, depth++) {
      const v = cur.getAttribute("data-testid");
      if (v && unique(`[data-testid="${attr(v)}"] ${tag}`) && unique(`[data-testid="${attr(v)}"]`)) return `[data-testid="${attr(v)}"] ${tag}`;
    }
    if (el.name) {
      const s = `${tag}[name="${attr(el.name)}"]`;
      if (unique(s) || el.type === "radio") return s;
    }
    // Walk up until the path names exactly one element: two fields must never share a selector.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (stableId(cur.id)) { parts.unshift("#" + cssEscape(cur.id)); break; }
      const t = cur.tagName.toLowerCase();
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      if (parts.length >= 3 && unique(parts.join(" > "))) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  // Placeholder-style labels say nothing about the question. The real question is the text block just above the control.
  const GENERIC = /^(select|select\.\.\.|select an option|select one|please select|choose|choose one|search|search\.\.\.|type to search|start typing\.*|textbox)?$/i;
  const questionFor = (el) => {
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 7; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib) {
        // The page title is not a question, and anything above it belongs to another part of the page.
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const t = text(sib);
        if (t && t.length <= LABEL_MAX && !GENERIC.test(t) && !sib.querySelector("input, select, textarea, [role=combobox]")) return t;
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  // What the site itself calls the control, as words: "phone_number-code" reads "phone number code".
  const ownName = (el) => {
    for (let cur = el, depth = 0; cur && depth < 8; cur = cur.parentElement, depth++) {
      const v = cur.getAttribute("data-testid") || cur.getAttribute("data-ui") || "";
      const words = v.replace(/^(input|select|field)[-_]/i, "").replace(/[-_]+/g, " ").trim();
      if (words && !/^(select|search|input|controller|option|wrapper)\b/i.test(words) && !/^[A-Za-z]{0,3}\d+$/.test(words)) return words;
    }
    return "";
  };
  const cleanLabel = (el, label) => {
    const stripped = label.replace(/^(select\.\.\.|select an option|select|search|textbox)\s+/i, "").trim();
    if (stripped && !GENERIC.test(stripped)) return stripped;
    return questionFor(el).replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX) || ownName(el) || label;
  };
  // A file box is usually labelled by its button ("Attach", "Choose file"). Which file it wants is said by the question above it.
  const FILE_BUTTON = /^(attach|upload|upload file|choose file|select file|browse|replace file|drop or select|drag and drop|svgs? not supported|file[-_ ]?input|file$|no file (selected|chosen)|dropbox|google drive|one ?drive|enter manually|from device|my computer)/i;
  // The question above a file box, skipping the box's own buttons ("Attach", "Dropbox", "Enter manually").
  const fileQuestion = (el) => {
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const t = text(sib);
        if (t && t.length <= LABEL_MAX && !GENERIC.test(t) && !FILE_BUTTON.test(t) && !sib.querySelector("input, select, textarea, button, [role=combobox]")) return t;
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  const fileLabel = (el, label) => {
    if (label && !FILE_BUTTON.test(label)) return label;
    const said = fileQuestion(el) || ownName(el) || (el.name || el.id || "").replace(/[-_]+/g, " ");
    return said && !FILE_BUTTON.test(said) ? `${said.replace(/\s*[*✱]\s*$/, "")} (${label || "file"})`.slice(0, LABEL_MAX) : label;
  };
  // The heading of the box a control sits in: the form's own label for the question, when the control itself carries no id for it.
  const fieldHeading = (el) => {
    const box = el.closest("fieldset, [class*=field-entry i], [class*=fieldEntry], [data-field-path]");
    if (!box) return null;
    const h = [...box.querySelectorAll("label, legend, [class*=question-title i]")].find((l) => !l.querySelector("input, select, textarea") && !(l.htmlFor && document.getElementById(l.htmlFor) && document.getElementById(l.htmlFor) !== el && /^(radio|checkbox)$/.test(document.getElementById(l.htmlFor).type || "")));
    return h && text(h) ? h : null;
  };
  const labelFor = (el) => {
    const bits = [];
    if (el.id) document.querySelectorAll(`label[for="${cssEscape(el.id)}"]`).forEach((l) => bits.push(text(l)));
    const al = el.getAttribute("aria-label"); if (al) bits.push(al);
    const by = el.getAttribute("aria-labelledby");
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(text(n)); });
    const wrap = el.closest("label"); if (wrap) bits.push(text(wrap).replace(text(el), ""));
    const isOption = el.type === "checkbox" || el.type === "radio";
    if (isOption && !bits.join("").trim()) {
      // An option's own text sits right after its box. The text before it belongs to the option above,
      // so it must never be used: that would tick the wrong box.
      const next = el.nextElementSibling;
      const after = next && !next.matches("input, select, textarea") ? text(next) : (el.nextSibling && el.nextSibling.nodeType === 3 ? el.nextSibling.textContent.trim() : "");
      return (after || el.value || el.id || "").replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX);
    }
    if (!bits.join("").trim()) { const h = fieldHeading(el); if (h) bits.push(text(h)); }
    if (!bits.join("").trim()) bits.push(questionFor(el));
    if (!bits.join("").trim()) {
      // Walk up to a field container and take its first heading or label-like text.
      let cur = el.parentElement, depth = 0;
      while (cur && depth < 4) {
        const l = cur.querySelector("label, legend, [class*=label i], [class*=question i], h3, h4, h5");
        if (l && text(l)) { bits.push(text(l)); break; }
        cur = cur.parentElement; depth++;
      }
    }
    return [...new Set(bits.map((b) => b.replace(/\s*[*✱]\s*$/, "").replace(/\s*[*✱]\s+/g, " ").trim()).filter(Boolean))].join(" ").slice(0, LABEL_MAX);
  };
  // The question a checkbox or radio belongs to: the nearest label or legend above it that is not an option's own label.
  const groupQuestionFor = (el) => {
    const isOptionLabel = (l) => {
      if (l.contains(el) || (el.id && l.htmlFor === el.id)) return true;
      const target = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector("input");
      return !!target && (target.type === "checkbox" || target.type === "radio");
    };
    let cur = el.parentElement;
    for (let depth = 0; cur && cur !== document.body && depth < 5; depth++, cur = cur.parentElement) {
      // A container that holds a whole form section is too wide to say which question this option answers.
      if (cur.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea").length > 1) break;
      const before = [...cur.querySelectorAll("legend, label, [class*=question-title i]")].filter((l) => !isOptionLabel(l) && text(l) && (l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (before.length) return text(before[before.length - 1]).replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX);
    }
    return "";
  };
  // The question above a group of options on a form that writes it as plain text, with no label or legend.
  // The walk stops at another question's controls, so an option never takes the question of the group before it.
  const optionQuestionFor = (el) => {
    const sameGroup = (node) => [...node.querySelectorAll("input, select, textarea")].every((i) => i.type === el.type && !!el.name && i.name === el.name);
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const holds = sib.querySelector("input, select, textarea, [role=combobox]");
        if (holds && !sameGroup(sib)) return "";
        const t = text(sib);
        if (!holds && t && t.length <= LABEL_MAX && !GENERIC.test(t)) return t.replace(/\s*[*✱]\s*$/, "");
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  const hintFor = (el) => {
    const by = el.getAttribute("aria-describedby");
    const bits = [];
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(text(n)); });
    // The box the control sits in, not the wrapper drawn right around the input, which holds no words of its own.
    const c = el.closest("fieldset, [class*=field-entry i], [class*=fieldEntry], [data-field-path]") || el.closest("[class*=field i], [class*=question i], [class*=form-group i], div");
    if (c) c.querySelectorAll("p, small, [class*=help i], [class*=hint i], [class*=description i]").forEach((n) => { const t = text(n); if (t && t.length < 400 && !n.querySelector("input, select, textarea")) bits.push(t); });
    return [...new Set(bits)].join(" ").slice(0, 400);
  };
  // The nearest heading or legend above the control, for context like "Education" or "Voluntary self-identification".
  const sectionFor = (el) => {
    const root = el.closest("form, [role=tabpanel], main") || document.body;
    let cur = el;
    while (cur && cur !== root && cur !== document.body) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$|^LEGEND$/.test(sib.tagName)) return text(sib).slice(0, 80);
        const h = sib.querySelector && sib.querySelector("h1, h2, h3, h4, legend");
        if (h && sib.querySelectorAll("input, select, textarea").length === 0) return text(h).slice(0, 80);
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  };
  // A field that says it is optional is optional, whatever the box around it is called.
  // A drawn picker keeps the real, required input out of sight in the same box (Workable's comboboxes).
  const hiddenRequiredTwin = (el) => { const box = el.closest("[data-input-type], [data-ui], [class*=field i]"); return !!box && [...box.querySelectorAll("input[required], select[required]")].some((t) => t !== el && !visible(t)); };
  const headingSaysRequired = (el) => { const h = fieldHeading(el); return !!h && (/required/i.test(String(h.className)) || /[*✱]\s*$|^\s*[*✱]/.test(text(h))); };
  const isRequired = (el, label) => !/\(optional\)/i.test(label) && (el.required || el.getAttribute("aria-required") === "true" || /[*✱]\s*$|^\s*[*✱]|\(required\)/i.test(label) || /required/i.test(el.closest("[class*=required i]")?.className || "") || hiddenRequiredTwin(el) || headingSaysRequired(el));

  // A plain text input with a suggestion list beside it (Lever's location box) only accepts a picked suggestion.
  const hasSuggestBox = (el) => el.tagName === "INPUT" && !!el.parentElement && !!el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i], [class*="typeahead" i], [class*="suggestions" i]');
  // A read-only input is a date box when it, or the field around it, says date, or a calendar hangs beside it.
  const DATE_WORD = /date|calendar|datepicker|\bdob\b|birthday/i;
  const looksLikeDateBox = (el) => {
    const own = `${el.className} ${el.name} ${el.id} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`;
    if (DATE_WORD.test(own)) return true;
    const item = el.closest("[variant], [class*=form-item i], [class*=field i]");
    if (item && (DATE_WORD.test(item.getAttribute("variant") || "") || item.querySelector('[class*="date-picker" i], [class*="datepicker" i], [class*="calendar" i]'))) return true;
    return !Number.isNaN(Date.parse(el.getAttribute("placeholder") || "")) && /\d{4}/.test(el.getAttribute("placeholder") || "");
  };
  // The widget that draws a control, when it is one the tool knows. Controls of one widget take values the same way.
  const widgetOf = (el, isCalendar, drawnByLabel) => {
    if (isCalendar) return "calendar";
    if (el.tagName === "BUTTON" && el.hasAttribute("aria-haspopup")) return "menu-button";
    if (el.closest('[data-automation-id="multiSelectContainer"]')) return "workday-prompt";
    if (el.closest(".iti")) return "intl-tel";
    if (el.closest('[class*="select__control"]')) return "react-select";
    if (el.closest(".selectize-input, .selectize-control")) return "selectize";
    if (el.parentElement && el.parentElement.querySelector("datalist")) return "datalist";
    if (el.closest('[data-testid="select-controller"]')) return "testid-select";
    if (drawnByLabel) return "label-drawn";
    if (el.tagName === "SELECT" && /select2-hidden/.test(el.className)) return "select2";
    return "";
  };
  // A button that opens a list of choices (aria-haspopup, BambooHR's pickers) is a dropdown drawn without an input.
  const MENU_BUTTON = 'button[aria-haspopup="true"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"]';
  // Menus in a page's own header (its language, the account) are the site's, not questions of the form.
  const CHROME = 'header, [role=banner], nav, [role=navigation], [data-automation-id="utilityButtonBar"]';
  // Workday keeps an application in one box of its page. What is outside it is the site's own.
  const FLOW = document.querySelector('[data-automation-id="applyFlowPage"]');
  // Workday's search-and-pick box: a search input, the list of what is picked, and a list that opens under it.
  const PROMPT = '[data-automation-id="multiSelectContainer"]';
  const pickedIn = (prompt) => {
    const rows = [...prompt.querySelectorAll('[data-automation-id="selectedItemList"] [role=option], [data-automation-id="selectedItem"]')];
    return rows.filter((r) => !rows.some((o) => o !== r && o.contains(r))).map(text).filter(Boolean).join(", ");
  };
  const controls = document.querySelectorAll(`input, select, textarea, [role=combobox], [role=listbox], ${MENU_BUTTON}`);
  const containerOf = (el) => el.closest("fieldset, [class*=field i], [class*=question i], [data-field-path], [id^=question], .form-group") || el.parentElement;
  const usedContainers = new Set();
  const dumped = new Set();
  const elementOf = new Map();
  let i = 0;
  controls.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
    if (SKIP_TYPES.has(type) && !el.matches(MENU_BUTTON)) return;
    // A box for a one-time code is never read: a code a site sends is typed by the person, or by the sign-in for an account they set up.
    if (/one-time-code/i.test(el.getAttribute("autocomplete") || "")) return;
    const isControl = ["input", "select", "textarea"].includes(tag);
    if ((el.closest(CHROME) && !el.closest("form")) || (FLOW && !FLOW.contains(el) && type !== "file")) return;
    const prompt = el.closest(PROMPT);
    // The list of what is picked is part of the box, not a question of its own.
    if (prompt && !isControl) return;
    // The list a combobox opens is that combobox's, not a question of its own.
    if (!isControl && el.id && document.querySelector(`[aria-controls="${attr(el.id)}"], [aria-owns="${attr(el.id)}"]`)) return;
    // Custom widgets (react-select wrappers, live regions) are reported once, through the real input in the same question.
    if (!isControl) {
      if (el.querySelector("input, select, textarea")) return;
      const c = containerOf(el);
      // An input kept out of sight in the same box (BambooHR's state.value) is the widget's own store, not the control.
      if (c && (usedContainers.has(c) || [...c.querySelectorAll("input:not([type=hidden]), select, textarea")].some(visible))) return;
    }
    if (isControl && type !== "radio") usedContainers.add(containerOf(el));
    // A radio or a checkbox is often drawn by its label, with the real box kept out of sight behind it.
    const drawnByLabel = (type === "radio" || type === "checkbox") && !visible(el) && [el.closest("label"), el.id && document.querySelector(`label[for="${cssEscape(el.id)}"]`), type === "checkbox" && el.closest("[role=checkbox]")].some((l) => l && visible(l));
    // A select2 list keeps the real <select> out of sight and draws its own box beside it.
    const drawnBySelect2 = tag === "select" && /select2-hidden/.test(el.className) && !!el.nextElementSibling && visible(el.nextElementSibling);
    if (!visible(el) && type !== "file" && !drawnByLabel && !drawnBySelect2) return;
    // A box that cannot be typed into is skipped, unless it is a date box set through a calendar
    // or a list that opens on a click (Workable draws its pickers as read-only comboboxes).
    const isCalendar = el.readOnly && isControl && tag === "input" && looksLikeDateBox(el);
    const isPicker = el.readOnly && el.getAttribute("role") === "combobox";
    if (el.disabled || (el.readOnly && !isCalendar && !isPicker)) return;
    // A text box hidden from people and from the keyboard is the site's own bookkeeping (the parts of an address it fills in itself).
    if (el.getAttribute("aria-hidden") === "true" && el.tabIndex === -1 && !["radio", "checkbox", "file"].includes(type) && !drawnBySelect2) return;
    const role = el.getAttribute("role");
    let kind;
    if (isCalendar) kind = "calendar";
    else if (tag === "select") kind = "select";
    else if (tag === "textarea") kind = "textarea";
    else if (role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || role === "listbox" || hasSuggestBox(el) || el.matches(MENU_BUTTON) || (prompt && tag === "input" && type === "text")) kind = "combobox";
    else if (type === "radio") kind = "radio";
    else if (type === "checkbox") kind = "checkbox";
    else if (type === "file") kind = "file";
    else if (["email", "tel", "url", "number", "date"].includes(type)) kind = type;
    else kind = "text";

    const f = {
      id: "f" + i++,
      widget: widgetOf(el, isCalendar, drawnByLabel),
      selector: selectorFor(el),
      kind,
      name: el.name || el.id || "",
      label: labelFor(el),
      hint: hintFor(el),
      placeholder: el.getAttribute("placeholder") || "",
      required: false,
      value: "",
      options: [],
      accept: el.getAttribute("accept") || "",
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      autocomplete: el.getAttribute("autocomplete") || "",
      section: sectionFor(el),
    };
    // For an option, the question it answers says more than the page section it sits in.
    if (kind === "checkbox" || kind === "radio") f.section = groupQuestionFor(el) || optionQuestionFor(el) || f.section;
    f.required = isRequired(el, f.label) || /[*✱]\s*$|^\s*[*✱]/.test(questionFor(el));
    if (el.matches(MENU_BUTTON)) {
      // The button's text is its current choice, or a placeholder. Its label is the form's own label for the box
      // around it, or its aria-label with that choice taken off the end ("Country United States").
      const own = text(el);
      const shownNow = /^[-–—\s]*(select|select\.\.\.|select an option|select one|choose|search|please select)?[-–—\s]*$/i.test(own) ? "" : own;
      let named = "";
      for (let cur = el, depth = 0; cur && depth < 5 && !named; cur = cur.parentElement, depth++) {
        if (cur.id) named = [...document.querySelectorAll(`label[for="${cssEscape(cur.id)}"]`)].map(text).join(" ");
      }
      const al = (el.getAttribute("aria-label") || "").trim();
      if (!named && al) named = own && al.endsWith(own) ? al.slice(0, -own.length).trim() : al;
      f.label = (named || f.label).slice(0, LABEL_MAX);
      f.value = shownNow;
      f.required = f.required || isRequired(el, f.label);
    }
    if (kind !== "radio" && kind !== "checkbox") f.label = cleanLabel(el, f.label);
    if (kind === "file") {
      f.label = fileLabel(el, f.label);
      f.required = f.required || /[*✱]\s*$/.test(fileQuestion(el));
    }

    if (kind === "radio") {
      const key = el.name || f.selector;
      if (seenRadio.has(key)) { i--; return; }
      seenRadio.add(key);
      const group = el.name ? document.querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`) : [el];
      group.forEach((r) => {
        const l = (r.id && document.querySelector(`label[for="${cssEscape(r.id)}"]`)) || r.closest("label");
        f.options.push({ value: r.value, label: text(l) || r.value });
        if (r.checked) f.value = r.value;
      });
      const fs = el.closest("fieldset, [role=radiogroup]");
      const named = fs && fs.getAttribute("aria-labelledby") ? fs.getAttribute("aria-labelledby").split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(" ") : "";
      if (fs && fs.querySelector("legend")) f.label = text(fs.querySelector("legend")) || f.label;
      else if (named) f.label = named.slice(0, LABEL_MAX);
      else if (!f.label || f.options.some((o) => o.label === f.label)) {
        let cur = el.parentElement, depth = 0;
        while (cur && depth < 5) { const l = cur.querySelector("legend, label, [class*=label i], h2, h3, h4"); if (l && text(l) && !f.options.some((o) => o.label === text(l))) { f.label = text(l); break; } cur = cur.parentElement; depth++; }
      }
      // The mark that a group is required sits on its question, not on its options.
      const box = el.closest("fieldset, [role=radiogroup], [class*=field-entry i], [class*=fieldEntry]");
      const head = box && [...box.querySelectorAll("legend, label, [class*=question-title i]")].find((h) => !h.querySelector("input") && !f.options.some((o) => o.label === text(h)));
      if (head && (/required/i.test(String(head.getAttribute("class") || "")) || /[*✱]\s*$|^\s*[*✱]/.test(text(head)))) f.required = true;
      if (box && box.getAttribute("aria-required") === "true") f.required = true;
      // The question itself may carry the mark, before or after the words.
      if (/^\s*[*✱]|[*✱]\s*$/.test(f.label) || /^\s*[*✱]/.test(f.section)) f.required = true;
      f.label = f.label.replace(/^\s*[*✱]\s*|\s*[*✱]\s*$/g, "");
    } else if (kind === "select") {
      [...el.options].forEach((o) => { if (o.value !== "" || o.text.trim()) f.options.push({ value: o.value, label: o.text.trim() }); });
      f.value = el.value;
    } else if (kind === "checkbox") {
      f.checked = el.checked;
      f.value = el.value;
    } else if (kind === "combobox") {
      f.value = (prompt ? pickedIn(prompt) : el.value) || f.value || "";
      const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      const list = listId ? document.getElementById(listId) : null;
      if (list) list.querySelectorAll("[role=option]").forEach((o) => f.options.push({ value: text(o), label: text(o) }));
    } else {
      f.value = el.value || f.value || "";
    }
    fields.push(f);
    dumped.add(el);
    elementOf.set(f, el);
  });

  // A group that keeps a named input of its own (Ashby's Yes/No rows do) is found by that name, which stays
  // put when a question appears above it. A path of positions would then point at another row.
  const groupSelectorFor = (c) => {
    const tag = c.tagName.toLowerCase();
    for (const inner of c.querySelectorAll(":scope > input[name]")) {
      const s = `${tag}:has(> input[name="${attr(inner.name)}"])`;
      if (unique(s)) return s;
    }
    return selectorFor(c);
  };
  // Button groups: a labelled field whose choices are plain <button>s (Ashby's Yes/No, some custom forms).
  const groupContainers = document.querySelectorAll("[class*=field-entry i], [class*=fieldEntry], [class*=question i], fieldset, [role=radiogroup], [role=group]");
  const seenGroup = new Set();
  groupContainers.forEach((c) => {
    // A radiogroup drawn with role=radio rows keeps its real inputs invisible; it is read through the rows.
    const drawnRadios = c.getAttribute("role") === "radiogroup" && c.querySelector("[role=radio]") && ![...c.querySelectorAll("input[type=radio]")].some((r) => seenRadio.has(r.name || ""));
    // Skip a container whose control was already read. An input nobody can see (Ashby keeps a hidden checkbox
    // behind its Yes and No buttons) does not count: the buttons are the control.
    if (!drawnRadios && [...c.querySelectorAll("input, select, textarea")].some((x) => x.type !== "hidden" && (dumped.has(x) || visible(x)))) return;
    const buttons = [...c.querySelectorAll("button, [role=radio], [role=option]")].filter((b) => visible(b) && text(b).length > 0 && text(b).length <= 90 && !/upload|browse|remove|submit|apply|next|continue|back/i.test(text(b)));
    if (buttons.length < 2 || buttons.length > 12) return;
    if ([...seenGroup].some((prev) => prev.contains(c) || c.contains(prev))) return;
    seenGroup.add(c);
    const labelEl = drawnRadios ? null : c.querySelector("label, legend, [class*=question-title i], [class*=label i], h2, h3, h4");
    const label = labelEl ? text(labelEl) : questionFor(c) || text(c).split("\n")[0];
    const selected = buttons.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked" || b.dataset.selected === "true");
    fields.push({
      id: "f" + i++,
      widget: drawnRadios ? "drawn-radio" : "buttons",
      selector: groupSelectorFor(c),
      kind: "radio",
      name: c.getAttribute("data-field-path") || "",
      label: label.replace(/\s*[*✱]\s*$/, "").replace(/^\s*[*✱]\s*/, "").slice(0, LABEL_MAX),
      hint: hintFor(c),
      placeholder: "",
      required: /required/i.test(labelEl?.className || "") || /[*✱]\s*$|^\s*[*✱]/.test(labelEl ? text(labelEl) : label) || c.getAttribute("aria-required") === "true" || !!c.querySelector('[aria-required="true"], input[required]'),
      value: selected ? text(selected) : "",
      options: buttons.map((b) => ({ value: text(b), label: text(b) })),
      accept: "",
      maxLength: null,
      autocomplete: "",
      section: sectionFor(c),
      buttonGroup: true,
    });
  });

  // The application is the <form> that holds the resume or the email box. A control that sits above
  // that form and outside it (a job-alert box, a site search) is not part of the application.
  const inForm = (kind) => fields.find((f) => f.kind === kind && elementOf.get(f) && elementOf.get(f).closest("form"));
  const anchor = inForm("file") || inForm("email");
  const application = anchor ? elementOf.get(anchor).closest("form") : null;
  if (application) {
    for (let k = fields.length - 1; k >= 0; k--) {
      const el = elementOf.get(fields[k]);
      if (el && !application.contains(el) && (application.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) fields.splice(k, 1);
    }
  }

  // Some careers sites embed the real form in an iframe (Greenhouse, Lever). Report those so the caller can navigate into one.
  out.hasPassword = [...document.querySelectorAll("input[type=password]")].some(visible);
  // Told by the frame's own host. A share widget that merely names a job board in its address is not a form.
  const hostOf = (src) => { try { return new URL(src).hostname; } catch { return ""; } };
  out.frames = [...document.querySelectorAll("iframe[src]")].map((f) => f.src).filter((src) => /greenhouse|lever\.co|ashbyhq|workday|smartrecruiters|jobvite|bamboohr|rippling|icims/i.test(hostOf(src)));
  // A take-home assignment the page asks for, with its link. The application still goes; the assignment is listed for the person.
  const TAKE_HOME = /take[- ]?home|coding (challenge|assessment|exercise)|technical assessment|complete the assignment/i;
  const URL_IN_TEXT = /https?:\/\/[^\s"')<>]+/;
  out.takeHome = [...document.querySelectorAll("p, li, div, label, legend, span")]
    .filter((n) => n.children.length < 8 && TAKE_HOME.test(text(n)) && text(n).length < 600 && (n.querySelector("a[href^='http']") || URL_IN_TEXT.test(text(n))))
    .filter((n, i, all) => !all.some((o) => o !== n && n.contains(o)))
    .slice(0, 3)
    .map((n) => ({ text: text(n).slice(0, 300), url: (n.querySelector("a[href^='http']") || {}).href || (URL_IN_TEXT.exec(text(n)) || [""])[0] }));
  const form = fields.length && document.querySelector(fields[0].selector)?.closest("form");
  const headings = [...(form || document).querySelectorAll("h1, h2, h3, p")].slice(0, 8).map(text).filter(Boolean);
  out.context = headings.join(" | ").slice(0, 800);
  const SUBMIT_WORD = /submit|apply|send|continue|next|review|finish|soumettre|postuler|envoyer/i;
  // JazzHR draws its Submit as a styled link.
  const submitLike = (root) => [...root.querySelectorAll("button, input[type=submit], [role=button], a[class*=submit i], a[class*=btn i]")].filter((b) => SUBMIT_WORD.test((text(b) || b.value || b.getAttribute("aria-label") || "").trim()) && visible(b));
  // The button may sit outside the form element (BambooHR draws it in a footer of its own), so the page is searched when the form has none.
  const buttons = form && submitLike(form).length ? submitLike(form) : submitLike(document);
  buttons.forEach((b) => {
    const t = (text(b) || b.value || b.getAttribute("aria-label") || "").trim();
    out.submitSelectors.push(selectorFor(b) + "  /* " + t.slice(0, 40) + " */");
  });
  return JSON.stringify(out);
})();
