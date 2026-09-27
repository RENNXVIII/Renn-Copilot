export type ToolTab = "rtk" | "ponytail";

/** Keep existing dashboard deep links working after merging the two pages. */
export function toolTabForPage(page: unknown): ToolTab | null {
  return page === "rtk" || page === "ponytail" ? page : null;
}