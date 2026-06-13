const form = document.getElementById("loginForm");
const message = document.getElementById("loginMessage");

async function checkExistingLogin() {
  const res = await fetch("/api/auth/status");
  const data = await res.json();
  if (data.authenticated) window.location.href = "/studio.html";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "正在登录...";
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("username").value.trim(),
      password: document.getElementById("password").value,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    message.textContent = data.error || "登录失败";
    return;
  }
  window.location.href = "/studio.html";
});

checkExistingLogin().catch(() => {});
