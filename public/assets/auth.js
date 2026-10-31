import { $ } from "./dom.js";
import { errorMessage } from "./format.js";

const form = $("#login-form") || $("#signup-form");
const isSignup = form.id === "signup-form";

for (const btn of document.querySelectorAll(".pw-toggle")) {
  btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
}

// Already signed in? Go straight to the app.
fetch("/v1/me", { credentials: "same-origin" }).then((r) => {
  if (r.ok) location.replace("/app");
});

function showFieldErrors(details) {
  for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  for (const d of details || []) {
    const input = form.elements[d.field];
    if (input) input.setAttribute("aria-invalid", "true");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  $("#form-error").textContent = "";
  button.disabled = true;
  button.textContent = isSignup ? "Creating account…" : "Signing in…";
  try {
    const res = await fetch(isSignup ? "/auth/signup" : "/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "fetch" },
      body: JSON.stringify(data),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      showFieldErrors(json?.error?.details);
      $("#form-error").textContent = res.status === 429 ? "Too many attempts. Please wait a minute and try again." : errorMessage(json);
      return;
    }
    location.replace("/app");
  } catch {
    $("#form-error").textContent = "Could not reach the server. Check your connection.";
  } finally {
    button.disabled = false;
    button.textContent = isSignup ? "Create account" : "Sign in";
  }
});
