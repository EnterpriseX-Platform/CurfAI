import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Up to two letters for an avatar: "Maya Okafor" → "MO", "Admin" → "AD",
 * "nok.srisuk@northwind.example" → "NS" (an email reads by its local part).
 */
export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") && !/\s/.test(nameOrEmail.trim()) ? nameOrEmail.split("@")[0]! : nameOrEmail;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  return (words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2)).toUpperCase() || "?";
}
