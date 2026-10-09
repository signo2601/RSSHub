// Global registries. View modules add their handlers at import time:
//   Object.assign(ACTIONS, { 'my-action': (el, ev) => { ... } });
// main.js delegates click / submit / input events to them.

export const ACTIONS = {}; // data-act="name"   → (el, event) => void
export const FORMS = {}; // form[data-form]   → (form, event) => void
export const INPUTS = {}; // data-input="name" → (el, event) => void (fires on input and change)
export const SHEETS = {}; // sheet name → (args) => ({ title, body, after?, size? })
export const FORM_SHEETS = new Set(); // sheets that hold a form: never re-rendered under the user
export const MOUNTS = []; // functions run after every page render (wire charts, focus, ...)
