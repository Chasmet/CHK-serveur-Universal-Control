import { join, dirname } from "node:path";
import { XDebtService } from "./xdebt.mjs";

/**
 * Shared app namespace registry for CHK Universal Control.
 * All apps use ONE Node process, ONE existing HTTP listener, ONE TLS ingress.
 * Each app module owns its own storage/auth and prefix; /mcp and /api remain
 * untouched. Register future apps in this file with their own prefix.
 */
export async function createApplicationRouter(config) {
  const xdebt = await new XDebtService(
    config.xdebtFile || join(dirname(config.file), "xdebt.json")
  ).init();

  const registrations = Object.freeze([
    Object.freeze({
      id: "xdebt",
      prefix: "/xdebt/api",
      maxBodyBytes: 180000,
      handler: (req, res, url, body, json) => xdebt.handle(req, res, url, body, json)
    })
  ]);

  // Fail fast on collisions; existing Universal namespaces are reserved.
  const reserved = ["/mcp", "/api", "/chat", "/oauth", "/health"];
  for (const route of registrations) {
    if (!/^\/[a-z][a-z0-9-]*\/(api|v[0-9]+)$/.test(route.prefix))
      throw new Error("invalid_application_prefix");
    if (reserved.some(prefix => route.prefix === prefix || route.prefix.startsWith(prefix + "/")))
      throw new Error("application_prefix_reserved");
    if (registrations.some(other => other !== route &&
      (route.prefix === other.prefix || route.prefix.startsWith(other.prefix + "/") ||
       other.prefix.startsWith(route.prefix + "/"))))
      throw new Error("application_prefix_conflict");
  }

  const routeFor = path => registrations.find(route =>
    path === route.prefix || path.startsWith(route.prefix + "/")
  );

  return Object.freeze({
    isApplicationPath: path => Boolean(routeFor(path)),
    bodyLimit: path => routeFor(path)?.maxBodyBytes ?? 32768,
    handle(req, res, url, body, json) {
      const route = routeFor(url.pathname);
      if (!route) return false;
      return route.handler(req, res, url, body, json);
    },
    apps: () => registrations.map(route => ({ id: route.id, prefix: route.prefix }))
  });
}
