"use client";

import { useEffect, useState } from "react";

/**
 * useDebounce — returns a debounced copy of the supplied value.
 * Useful for search inputs (300ms is the recommended delay).
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
