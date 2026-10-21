// Task #276 — the pure gallery-list query state. Node environment, no DB, no
// React: every case here is URL-parse / URL-build / toggle arithmetic, which
// is exactly the part of this slice that can be proven without rendering.
import { describe, expect, it } from "vitest";
import { galleryStatus } from "@/lib/db/schema";
import {
  DEFAULT_GALLERY_LIST_QUERY,
  DEFAULT_SORT_DIRECTION,
  GALLERY_LIST_PATH,
  GALLERY_PAGE_SIZE,
  GALLERY_SORT_KEYS,
  GALLERY_STATUSES,
  GALLERY_STATUS_RANK,
  clampPage,
  galleryListHref,
  pageCountFor,
  parseGalleryListQuery,
  sortOptionValue,
  sortedBy,
  withSortOption,
  withStatus,
  type GalleryListQuery,
} from "./gallery-list-query";

describe("parseGalleryListQuery", () => {
  it("normalizes no params to the default state", () => {
    expect(parseGalleryListQuery({})).toEqual(DEFAULT_GALLERY_LIST_QUERY);
  });

  it("accepts every legal status", () => {
    for (const status of GALLERY_STATUSES) {
      expect(parseGalleryListQuery({ status }).status).toBe(status);
    }
  });

  it("accepts every legal sort, with its default direction", () => {
    for (const sort of GALLERY_SORT_KEYS) {
      expect(parseGalleryListQuery({ sort })).toEqual({
        status: null,
        sort,
        dir: DEFAULT_SORT_DIRECTION[sort],
        page: 1,
      });
    }
  });

  it.each([
    ["asc", "asc"],
    ["desc", "desc"],
  ] as const)("accepts dir=%s when a sort is set", (dir, expected) => {
    expect(parseGalleryListQuery({ sort: "title", dir }).dir).toBe(expected);
  });

  it.each(["Draft", "draftt", "", "toString", "__proto__"])(
    "treats unknown status %j as no filter",
    (status) => {
      expect(parseGalleryListQuery({ status }).status).toBeNull();
    },
  );

  it.each(["Title", "createdAt", "", "constructor"])(
    "treats unknown sort %j as the default order",
    (sort) => {
      expect(parseGalleryListQuery({ sort })).toEqual(DEFAULT_GALLERY_LIST_QUERY);
    },
  );

  it("ignores dir when no sort is set — recency is always desc", () => {
    expect(parseGalleryListQuery({ dir: "asc" }).dir).toBe("desc");
  });

  it("falls back to the sort's default direction for an unknown dir", () => {
    expect(parseGalleryListQuery({ sort: "session", dir: "sideways" }).dir).toBe("desc");
    expect(parseGalleryListQuery({ sort: "title", dir: "sideways" }).dir).toBe("asc");
  });

  it("takes the FIRST value of a repeated param, like URLSearchParams.get()", () => {
    expect(parseGalleryListQuery({ status: ["draft", "proofing"] }).status).toBe("draft");
    expect(parseGalleryListQuery({ sort: ["photos", "title"] }).sort).toBe("photos");
    expect(parseGalleryListQuery({ page: ["4", "9"] }).page).toBe(4);
  });

  it.each(["0", "-1", "abc", "2.5", "1e3", "03", ""])("rejects page=%j as page 1", (page) => {
    expect(parseGalleryListQuery({ page }).page).toBe(1);
  });

  it("accepts a positive page and does not clamp it here", () => {
    expect(parseGalleryListQuery({ page: "7" }).page).toBe(7);
    expect(parseGalleryListQuery({ page: "99999999999999999999" }).page).toBeGreaterThan(7);
  });
});

describe("galleryListHref", () => {
  it("emits the bare path for the default state", () => {
    expect(galleryListHref(DEFAULT_GALLERY_LIST_QUERY)).toBe(GALLERY_LIST_PATH);
  });

  it("omits every param equal to its default", () => {
    expect(galleryListHref({ status: null, sort: "title", dir: "asc", page: 1 })).toBe(
      "/dashboard/galleries?sort=title",
    );
    expect(galleryListHref({ status: null, sort: null, dir: "desc", page: 1 })).toBe(
      GALLERY_LIST_PATH,
    );
    expect(galleryListHref({ status: "draft", sort: null, dir: "desc", page: 1 })).toBe(
      "/dashboard/galleries?status=draft",
    );
  });

  it("emits params in the fixed status, sort, dir, page order", () => {
    expect(galleryListHref({ status: "draft", sort: "photos", dir: "asc", page: 3 })).toBe(
      "/dashboard/galleries?status=draft&sort=photos&dir=asc&page=3",
    );
  });

  it("round-trips through the URL for every canonical state", () => {
    const statuses = [null, ...GALLERY_STATUSES];
    const sorts = [null, ...GALLERY_SORT_KEYS];
    const directions = ["asc", "desc"] as const;

    for (const status of statuses) {
      for (const sort of sorts) {
        for (const dir of directions) {
          // Without a sort, `dir` is normalized to "desc" — anything else is
          // not a canonical state and is not what this round-trip promises.
          if (sort === null && dir !== "desc") continue;
          for (const page of [1, 2]) {
            const query: GalleryListQuery = { status, sort, dir, page };
            const href = galleryListHref(query);
            const parsed = parseGalleryListQuery(
              Object.fromEntries(new URL(href, "http://x").searchParams),
            );
            expect(parsed).toEqual(query);
          }
        }
      }
    }
  });
});

describe("paging", () => {
  it.each([
    [0, 1],
    [1, 1],
    [GALLERY_PAGE_SIZE, 1],
    [GALLERY_PAGE_SIZE + 1, 2],
    [63, 3],
  ])("pageCountFor(%i) is %i", (matching, expected) => {
    expect(pageCountFor(matching)).toBe(expected);
  });

  it("clamps an out-of-range page to the last page", () => {
    expect(clampPage({ ...DEFAULT_GALLERY_LIST_QUERY, page: 99 }, 63).page).toBe(3);
  });

  it("keeps an in-range page untouched", () => {
    expect(clampPage({ ...DEFAULT_GALLERY_LIST_QUERY, page: 2 }, 63).page).toBe(2);
  });
});

describe("sortedBy", () => {
  it("starts a new column at its default direction and resets the page", () => {
    expect(sortedBy({ status: "draft", sort: null, dir: "desc", page: 4 }, "session")).toEqual({
      status: "draft",
      sort: "session",
      dir: "desc",
      page: 1,
    });
    expect(sortedBy({ status: "draft", sort: null, dir: "desc", page: 4 }, "title")).toEqual({
      status: "draft",
      sort: "title",
      dir: "asc",
      page: 1,
    });
  });

  it("reverses the active column and resets the page", () => {
    expect(sortedBy({ status: null, sort: "title", dir: "asc", page: 3 }, "title")).toEqual({
      status: null,
      sort: "title",
      dir: "desc",
      page: 1,
    });
    expect(sortedBy({ status: null, sort: "photos", dir: "desc", page: 3 }, "photos")).toEqual({
      status: null,
      sort: "photos",
      dir: "asc",
      page: 1,
    });
  });
});

describe("filter and sort selects", () => {
  it("withStatus keeps the sort and resets the page", () => {
    expect(withStatus({ status: null, sort: "photos", dir: "asc", page: 3 }, "archived")).toEqual({
      status: "archived",
      sort: "photos",
      dir: "asc",
      page: 1,
    });
  });

  it("sortOptionValue and withSortOption round-trip all 13 option values", () => {
    const values = ["", ...GALLERY_SORT_KEYS.flatMap((key) => [`${key}:asc`, `${key}:desc`])];

    for (const value of values) {
      const query = withSortOption({ ...DEFAULT_GALLERY_LIST_QUERY }, value);
      expect(sortOptionValue(query)).toBe(value);
    }
  });

  it("withSortOption decodes '' to the default recency order and resets the page", () => {
    expect(withSortOption({ status: "draft", sort: "title", dir: "asc", page: 3 }, "")).toEqual({
      status: "draft",
      sort: null,
      dir: "desc",
      page: 1,
    });
  });

  it("withSortOption resets the page and keeps the filter", () => {
    expect(
      withSortOption({ status: "draft", sort: null, dir: "desc", page: 3 }, "photos:desc"),
    ).toEqual({ status: "draft", sort: "photos", dir: "desc", page: 1 });
  });

  it("withSortOption treats an unknown value as the default order", () => {
    expect(
      withSortOption({ status: null, sort: "title", dir: "asc", page: 2 }, "bogus:asc"),
    ).toEqual(DEFAULT_GALLERY_LIST_QUERY);
  });
});

describe("GALLERY_STATUS_RANK", () => {
  it("ranks every gallery_status enum value exactly once", () => {
    expect(new Set(Object.keys(GALLERY_STATUS_RANK))).toEqual(new Set(galleryStatus.enumValues));
  });

  it("orders GALLERY_STATUSES by rank, draft first and archived last", () => {
    expect(GALLERY_STATUSES).toEqual(["draft", "proofing", "selected", "delivered", "archived"]);
  });
});
