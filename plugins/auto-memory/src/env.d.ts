// Text files the build inlines, imported with `with { type: "text" }` (Vitest loads them the same
// way). This plugin's tsconfig.json leaves Bun's types out, which call an .html import an HTMLBundle.
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
