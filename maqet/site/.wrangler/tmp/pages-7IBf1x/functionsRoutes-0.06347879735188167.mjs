import { onRequest as __api_showcase___path___js_onRequest } from "/home/mini-clanker/.openclaw/workspace/projects/maqet.org-site/maqet/site/functions/api/showcase/[[path]].js"

export const routes = [
    {
      routePath: "/api/showcase/:path*",
      mountPath: "/api/showcase",
      method: "",
      middlewares: [],
      modules: [__api_showcase___path___js_onRequest],
    },
  ]