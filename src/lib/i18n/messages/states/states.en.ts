import type { Dictionary } from "../../locales";

// What a page says when it can't show itself (en): app/error.tsx and app/not-found.tsx.
export const statesEn: Dictionary = {
  "states.error.title": "This page couldn't load",
  "states.error.body": "Something went wrong on our side. Try again, or go back to the start page.",
  "states.error.retry": "Try again",
  "states.error.reference": "Reference",
  "states.notFound.title": "We couldn't find that page",
  "states.notFound.body": "The link may be old, or the item was moved or deleted. It may also belong to a workspace you aren't in.",
  "states.home": "Go to the start page",
};
