import type { Dictionary } from "../../locales";

// What a page says when it can't show itself (zh): app/error.tsx and app/not-found.tsx.
export const statesZh: Dictionary = {
  "states.error.title": "此页面无法加载",
  "states.error.body": "我们这边出了问题。请重试，或返回起始页。",
  "states.error.retry": "重试",
  "states.error.reference": "参考编号",
  "states.notFound.title": "找不到该页面",
  "states.notFound.body": "链接可能已过期，或该内容已被移动或删除。它也可能属于您未加入的工作区。",
  "states.home": "前往起始页",
};
