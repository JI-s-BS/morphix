// Small server-rendered pages: Auth0 setup, sign-in problems, "not on the list yet".

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(title: string, emoji: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Morphix</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<main class="screen center">
<div class="card notice">
<div class="big-emoji" aria-hidden="true">${emoji}</div>
<h1>${escapeHtml(title)}</h1>
${body}
</div>
</main>
</body>
</html>`;
}

export function setupPage(missing: string[], problems: string[]): string {
  const items = [...missing.map((k) => `<li><code>${escapeHtml(k)}</code> is not set</li>`), ...problems.map((p) => `<li>${escapeHtml(p)}</li>`)].join("");
  return page(
    "Morphix needs a grown-up",
    "🔧",
    `<p>The web portal is switched off until sign-in is set up.</p>
<ul class="plain">${items}</ul>
<p class="small">Put these in <code>~/Morphix/config/morphix.env</code> on the Morphix computer and restart it.
The steps are in <code>docs/PORTAL.md</code>.</p>`,
  );
}

export function loginProblemPage(message: string): string {
  return page("Oops, sign-in didn't work", "🙈", `<p>${escapeHtml(message)}</p><p><a class="btn btn-primary" href="/login">Try again</a></p>`);
}

export function notAllowedPage(email: string): string {
  return page(
    "You're not on the list yet",
    "📝",
    `<p>You signed in as <strong>${escapeHtml(email)}</strong>, but this Morphix only lets in people on its list.</p>
<p class="small">A grown-up can add you: put your e-mail in <code>AUTH0_ALLOWED_EMAILS</code>
(comma-separated) in <code>~/Morphix/config/morphix.env</code> on the Morphix computer, then restart Morphix.</p>
<p><a class="btn" href="/">Back</a></p>`,
  );
}

export function emailUnverifiedPage(): string {
  return page(
    "Please check your e-mail first",
    "📬",
    `<p>Your account's e-mail address isn't confirmed yet. Open the e-mail from Auth0, tap the link, then try again.</p>
<p><a class="btn btn-primary" href="/login">Try again</a></p>`,
  );
}
