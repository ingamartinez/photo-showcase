// What `import "server-only"` resolves to under Vitest — wired up by
// `resolve.alias` in vitest.config.ts (task #31). See that entry's own comment
// for why this file exists and, more importantly, for what it does NOT buy.
//
// Deliberately inert. That is exactly what Next.js's own SERVER graph resolves
// `server-only` to: the marker's whole job is to be harmless on the server and
// to throw in the CLIENT graph. Every test in this repo either calls server
// code directly or renders a server component to an element, so server-graph
// behaviour is the correct one to emulate here.
export {};
