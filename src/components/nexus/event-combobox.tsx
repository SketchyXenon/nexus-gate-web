"use client";

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, CalendarDays, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";
import type { EventItem } from "@/lib/api-client";

export interface EventComboboxProps {
  events: EventItem[];
  /** Currently selected event id (number), or null if none. */
  value: number | null;
  /** Called when the user picks an event (id) or clears (null). */
  onChange: (id: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Whether to show the event date next to the title in the list. */
  showDate?: boolean;
  className?: string;
  /**
   * If true, the list shows an "All events" pseudo-entry at the top that
   * calls onChange(null). Useful for filter dropdowns where "no event" is a
   * valid choice meaning "all events".
   */
  allowClear?: boolean;
  /** Label shown for the "all" entry when allowClear is true. */
  allLabel?: string;
}

/**
 * EventCombobox — a searchable, paginated event picker.
 * Falls back gracefully when there are zero events.
 *
 * Use this instead of <Select> when the event list is long (more than ~20).
 */
export function EventCombobox({
  events,
  value,
  onChange,
  placeholder = "Search event…",
  disabled,
  showDate = true,
  className,
  allowClear = false,
  allLabel = "All events",
}: EventComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Reset the search field when the popover closes. Done in the open-change
  // handler instead of an effect to avoid the "setState in effect" anti-pattern.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  const selected = useMemo(
    () => events.find((e) => e.id === value) ?? null,
    [events, value]
  );

  // cmdk filters case-insensitively by default; we also widen it to include
  // the date string so users can search by "2025-03" etc.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => {
      const haystack = [
        e.title,
        e.targetProgram ?? "",
        e.targetSection ?? "",
        e.scope,
        e.scheduledAt,
        format(new Date(e.scheduledAt), "MMM d yyyy"),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [events, query]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || events.length === 0}
          className={cn(
            "h-10 w-full justify-between font-normal",
            !selected && !allowClear && "text-muted-foreground",
            className
          )}
        >
          <span className="flex items-center gap-2 truncate min-w-0">
            {selected ? (
              <>
                <span className="truncate">{selected.title}</span>
                {showDate && (
                  <Badge variant="outline" className="hidden sm:inline-flex shrink-0 text-[10px] font-mono">
                    {format(new Date(selected.scheduledAt), "MMM d")}
                  </Badge>
                )}
              </>
            ) : allowClear ? (
              <span className="text-foreground">{allLabel}</span>
            ) : events.length === 0 ? (
              "No events available"
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex h-9 items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 opacity-50" />
            <CommandInput
              placeholder="Type to search events…"
              className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <CommandList>
            <CommandEmpty>
              {events.length === 0
                ? "No events yet."
                : "No event matches your search."}
            </CommandEmpty>
            {allowClear && (
              <CommandGroup>
                <CommandItem
                  value="__all__"
                  onSelect={() => {
                    onChange(null);
                    handleOpenChange(false);
                  }}
                  className="gap-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value == null ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="text-sm font-medium">{allLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {filtered.map((e) => (
                <CommandItem
                  key={e.id}
                  value={String(e.id)}
                  onSelect={() => {
                    onChange(e.id);
                    handleOpenChange(false);
                  }}
                  className="gap-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value === e.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate text-sm">{e.title}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <CalendarDays className="h-3 w-3" />
                      {format(new Date(e.scheduledAt), "MMM d, yyyy · HH:mm")}
                      {e.targetProgram && (
                        <Badge variant="outline" className="ml-1 text-[10px] py-0 px-1">
                          {e.targetProgram}
                          {e.targetSection ? ` · ${e.targetSection}` : ""}
                        </Badge>
                      )}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
