// Re-export only the zod validators from the generated output.
// The separate "types/" folder is intentionally not re-exported here because
// Orval generates equivalent type aliases directly in api.ts via z.infer, and
// re-exporting both causes duplicate identifier errors (e.g. ExtractDocumentBody).
export * from "./generated/api";

// Strict primitive validators (shared between server and frontend)
export * from "./primitives";

// Strict input schemas (used by route handlers and form resolvers)
export * from "./strict-input";
