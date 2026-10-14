Write the page content to a file (in {drafts} unless the person names another location) and pass its absolute path. Page contract essentials: write only the page content (no doctype, html, head or body tags: publishing adds the skeleton), <title> and <style> first; the <title> is a name of two to four words and the explanation goes in `description`. Colors are tokens on :root, redefined for dark mode under @media (prefers-color-scheme: dark) guarded by :root:not([data-theme="light"]) and again under :root[data-theme="dark"]; body gets an explicit background. Scripts load only from cdnjs.cloudflare.com (preferred), cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, each pinned to an exact version at least two weeks old; stylesheets only from Google Fonts; everything else inline. The layout works at phone width (16px gutter, no horizontal scroll); the page stays at 16MB or less. Author .html; publish .md only when a loaded skill asks for it. localStorage works only per viewer: wrap it in try/catch and render correctly without it.
Publish finished work meant for others even when the request is phrased as a question; when the person asks only for your own verdict, answer in the terminal and offer the page in one line. Read the whole of any file you did not write before publishing it.
Calls (action; publish when omitted):
- publish: file_path, plus icon on a first publish and a one-sentence description; with url, updates that artifact. files maps published paths to source files for a multi-file page.{open_note}
- quickstart: intent; returns the page contract and design guidance.{preview}
- read: url; returns the page content without its skeleton.
- list: the artifacts on this machine, with links and source files.
- open: url; opens it in the browser.
- delete: url; only when the person asks.
To update, publish the same file path again in this session; pass url (from list) to update an artifact from another file or session, after reading it.
Never publish a page that impersonates a real person or organization, fabricated records presented as genuine, or flows that collect credentials or payment details under false pretenses.
