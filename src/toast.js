// Unified transient toast notifications. Replaces the two near-identical
// ad-hoc implementations that used to live inline in app.js (showSuccess/
// showError), which injected their own <style> into <head> and both
// anchored at the same fixed position — so two toasts firing close together
// would overlap. This stacks them instead.

const TOAST_ICON = {
  success: "check-circle",
  error: "alert-triangle",
  warning: "alert-triangle",
  info: "info",
};
const TOAST_DURATION = { success: 3000, error: 5000, warning: 5000, info: 3500 };
const TOAST_MAX_VISIBLE = 3;

function ensureToastStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}

/**
 * @param {string} message
 * @param {"success"|"error"|"warning"|"info"} type
 * @param {{icon?: string, duration?: number}} [opts]
 */
function toast(message, type, opts) {
  type = type || "info";
  opts = opts || {};
  const stack = ensureToastStack();
  while (stack.children.length >= TOAST_MAX_VISIBLE) {
    stack.firstElementChild.remove();
  }

  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.innerHTML =
    '<span class="toast-icon">' + icon(opts.icon || TOAST_ICON[type], 16) + "</span>" +
    '<span class="toast-msg"></span>' +
    '<button class="toast-close" aria-label="Dismiss" onclick="this.closest(\'.toast\').remove()">' +
    icon("x", 12) +
    "</button>";
  el.querySelector(".toast-msg").textContent = message;
  stack.appendChild(el);

  const duration = opts.duration || TOAST_DURATION[type];
  setTimeout(() => {
    if (el.parentElement) el.remove();
  }, duration);
  return el;
}
