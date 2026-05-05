// Ambient declarations for static `with { type: "file" }` imports of runtime assets.
// Bun resolves these to absolute paths (dev) or /$bunfs/... paths (compiled binary).
declare module "*.conf" {
  const path: string;
  export default path;
}
