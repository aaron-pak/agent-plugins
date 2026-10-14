// Text files the build inlines, imported with `with { type: "text" }`. Bun's own types call an .html
// import an HTMLBundle instead, so the tests' typecheck sees that; the sources wrap one in String().
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
