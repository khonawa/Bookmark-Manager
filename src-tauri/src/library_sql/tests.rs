use super::*;
use std::time::Instant;

fn db() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    initialize(&connection).unwrap();
    connection
}

fn bookmark(i: usize) -> Bookmark {
    Bookmark {
        id: format!("b{i:06}"),
        title: format!("Article {:06}", i % 100),
        url: format!("https://www.site{}.example/articles/{i}#section", i % 40),
        description: format!("Reading notes {i} café"),
        tags: if i % 2 == 0 {
            vec!["work".into(), "rust".into()]
        } else {
            vec![]
        },
        collection_ids: if i % 3 == 0 {
            vec!["reading".into()]
        } else {
            vec![]
        },
        created_at: format!("2026-11-{:02}T12:00:00Z", 1 + i % 28),
    }
}

#[test]
fn realistic_import_query_and_single_edit_measurements() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("performance-test-{}.sqlite3", std::process::id()));
    let mut connection = Connection::open(&path).unwrap();
    initialize(&connection).unwrap();
    let mut patch = LibraryPatch {
        bookmarks: (0..25_000).map(bookmark).collect(),
        collections: vec![Collection {
            id: "reading".into(),
            name: "Reading".into(),
            parent_id: None,
        }],
        trash: (25_000..25_100)
            .map(|i| TrashedBookmark {
                bookmark: bookmark(i),
                deleted_at: "2026-11-13T00:00:00Z".into(),
            })
            .collect(),
        ..Default::default()
    };
    let start = Instant::now();
    let before = connection.total_changes();
    apply(&mut connection, &patch).unwrap();
    let imported = start.elapsed();
    let rows = connection.total_changes() - before;
    // Each library row mutation also advances the revision through a trigger.
    assert_eq!(rows, 25_101 * 2);
    let start = Instant::now();
    let first = query(&mut connection, "all", "", "", "newest", 0).unwrap();
    let queried = start.elapsed();
    assert_eq!(first.total, 25_000);
    assert_eq!(first.bookmarks.len(), 75);
    let second = query(&mut connection, "all", "", "", "newest", 1).unwrap();
    assert!(first
        .bookmarks
        .iter()
        .all(|b| !second.bookmarks.iter().any(|other| other["id"] == b["id"])));
    patch.bookmarks.truncate(1);
    patch.collections.clear();
    patch.trash.clear();
    patch.bookmarks[0].title = "Edited only row".into();
    let before = connection.total_changes();
    let start = Instant::now();
    apply(&mut connection, &patch).unwrap();
    let edited = start.elapsed();
    assert_eq!(connection.total_changes() - before, 2);
    let before = connection.total_changes();
    apply(&mut connection, &patch).unwrap();
    assert_eq!(connection.total_changes() - before, 0);
    assert_eq!(
        query(&mut connection, "all", "", "Edited only row", "title", 1)
            .unwrap()
            .total,
        1
    );
    println!("25k import (file-backed WAL/FULL): {imported:?}, rows={rows}; first SQL page+count: {queried:?}; single edit: {edited:?}, rows=1; unchanged replay rows=0");
    drop(connection);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn filters_pagination_sorts_and_trash() {
    let mut connection = db();
    apply(
        &mut connection,
        &LibraryPatch {
            bookmarks: (0..160).map(bookmark).collect(),
            trash: vec![TrashedBookmark {
                bookmark: bookmark(200),
                deleted_at: "yesterday".into(),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    for (view, tag, search, expected) in [
        ("all", "", "", 160),
        ("inbox", "", "", 106),
        ("untagged", "", "", 80),
        ("reading", "", "", 54),
        ("collection:reading", "work", "", 27),
        ("all", "work", "", 80),
        ("all", "", "rust", 80),
        ("all", "", "notes 159", 1),
        ("all", "", "/articles/159#", 1),
        ("all", "", "ARTICLE", 160),
        ("all", "", "%", 0),
        ("missing", "", "", 0),
    ] {
        assert_eq!(
            query(&mut connection, view, tag, search, "newest", 1)
                .unwrap()
                .total,
            expected,
            "{view}/{tag}/{search}"
        );
    }
    for sort in ["newest", "title", "domain"] {
        let a = query(&mut connection, "all", "", "", sort, 0).unwrap();
        let b = query(&mut connection, "all", "", "", sort, -10).unwrap();
        assert_eq!(a.bookmarks, b.bookmarks);
        assert_eq!(
            query(&mut connection, "all", "", "", sort, i64::MAX)
                .unwrap()
                .bookmarks
                .len(),
            10
        );
        let repeated = query(&mut connection, "all", "", "", sort, 0).unwrap();
        assert_eq!(a.bookmarks, repeated.bookmarks);
        let keys: Vec<_> = a
            .bookmarks
            .iter()
            .map(|b| match sort {
                "title" => (
                    b["title"].as_str().unwrap().to_lowercase(),
                    b["id"].as_str().unwrap().to_string(),
                ),
                "domain" => (
                    url::Url::parse(b["url"].as_str().unwrap())
                        .unwrap()
                        .host_str()
                        .unwrap()
                        .trim_start_matches("www.")
                        .into(),
                    b["id"].as_str().unwrap().to_string(),
                ),
                _ => (
                    b["createdAt"].as_str().unwrap().into(),
                    b["id"].as_str().unwrap().into(),
                ),
            })
            .collect();
        assert!(keys.windows(2).all(|w| if sort == "newest" {
            w[0].0 > w[1].0 || (w[0].0 == w[1].0 && w[0].1 < w[1].1)
        } else {
            w[0] < w[1]
        }));
    }
    let trash = query(&mut connection, "trash", "work", "rust", "domain", 1).unwrap();
    assert_eq!(trash.total, 1);
    assert_eq!(trash.bookmarks[0]["deletedAt"], "yesterday");
    assert!(query(&mut connection, "all", "", "", "bad", 1).is_err());
    assert!(serde_json::from_value::<QueryInput>(
        serde_json::json!({"view":"all","tag":"","query":"","sort":"newest","page":1.5})
    )
    .is_err());
}

#[test]
fn zero_based_pages_and_boundary_clamps() {
    let mut connection = db();
    apply(
        &mut connection,
        &LibraryPatch {
            bookmarks: (0..160).map(bookmark).collect(),
            ..Default::default()
        },
    )
    .unwrap();
    let page = |connection: &mut Connection, number| {
        query(connection, "all", "", "", "domain", number).unwrap()
    };
    let expected = {
        let mut statement = connection
            .prepare("SELECT id FROM bookmarks ORDER BY bookmark_domain(url), id")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    for number in 0..=2 {
        let result = page(&mut connection, number);
        assert_eq!(result.total, 160);
        let ids: Vec<_> = result
            .bookmarks
            .iter()
            .map(|b| b["id"].as_str().unwrap().to_string())
            .collect();
        let start = number as usize * 75;
        assert_eq!(ids, expected[start..(start + 75).min(160)]);
    }
    assert_eq!(
        page(&mut connection, i64::MIN).bookmarks,
        page(&mut connection, 0).bookmarks
    );
    assert_eq!(
        page(&mut connection, i64::MAX).bookmarks,
        page(&mut connection, 2).bookmarks
    );
    for number in [i64::MIN, 0, 1, i64::MAX] {
        let empty = query(&mut connection, "missing", "", "", "newest", number).unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.bookmarks.is_empty());
        let exact = query(&mut connection, "all", "", "", "newest", number).unwrap();
        assert!(!exact.bookmarks.is_empty());
    }
    connection
        .execute("DELETE FROM bookmarks WHERE id >= 'b000150'", [])
        .unwrap();
    assert_eq!(
        page(&mut connection, i64::MAX).bookmarks,
        page(&mut connection, 1).bookmarks
    );
    assert_eq!(page(&mut connection, 1).bookmarks.len(), 75);
}

#[test]
fn validation_and_sql_failure_roll_back_every_table() {
    let mut connection = db();
    apply(
        &mut connection,
        &LibraryPatch {
            bookmarks: vec![bookmark(0)],
            ..Default::default()
        },
    )
    .unwrap();
    let original = read_library(&mut connection).unwrap();
    for patch in [
        LibraryPatch {
            bookmarks: vec![bookmark(1), bookmark(1)],
            ..Default::default()
        },
        LibraryPatch {
            bookmarks: vec![bookmark(0)],
            deleted_bookmark_ids: vec!["b000000".into()],
            ..Default::default()
        },
        LibraryPatch {
            deleted_trash_ids: vec![" ".into()],
            ..Default::default()
        },
    ] {
        assert!(apply(&mut connection, &patch).is_err());
        assert_eq!(read_library(&mut connection).unwrap(), original);
    }
    connection.execute_batch("CREATE TRIGGER reject_trash BEFORE INSERT ON trash BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(apply(
        &mut connection,
        &LibraryPatch {
            bookmarks: vec![bookmark(1)],
            deleted_bookmark_ids: vec!["b000000".into()],
            collections: vec![Collection {
                id: "c".into(),
                name: "C".into(),
                parent_id: None
            }],
            trash: vec![TrashedBookmark {
                bookmark: bookmark(2),
                deleted_at: "now".into()
            }],
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(read_library(&mut connection).unwrap(), original);
}

#[test]
fn incremental_order_moves_and_legacy_full_save() {
    let mut connection = db();
    write_library(
        &mut connection,
        &Library {
            bookmarks: vec![bookmark(9), bookmark(1)],
            ..Default::default()
        },
    )
    .unwrap();
    apply(
        &mut connection,
        &LibraryPatch {
            bookmarks: vec![bookmark(9), bookmark(3)],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        read_library(&mut connection)
            .unwrap()
            .bookmarks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b000009", "b000001", "b000003"]
    );
    apply(
        &mut connection,
        &LibraryPatch {
            deleted_bookmark_ids: vec!["b000001".into()],
            trash: vec![TrashedBookmark {
                bookmark: bookmark(1),
                deleted_at: "now".into(),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let library = read_library(&mut connection).unwrap();
    assert_eq!(library.bookmarks.len(), 2);
    assert_eq!(library.trash.len(), 1);
    initialize(&connection).unwrap();
    assert_eq!(read_library(&mut connection).unwrap(), library);
    write_library(&mut connection, &library).unwrap();
    assert_eq!(read_library(&mut connection).unwrap(), library);
}

#[test]
fn stale_patch_cannot_overwrite_extension_save() {
    let mut c = db();
    let revision = connector::revision(&c).unwrap();
    let mut patch = LibraryPatch {
        bookmarks: vec![bookmark(1)],
        ..Default::default()
    };
    let next = apply_checked(&mut c, &patch, Some(&revision)).unwrap();
    patch.bookmarks[0].title = "Stale edit".into();
    assert_eq!(
        apply_checked(&mut c, &patch, Some(&revision)).unwrap_err(),
        "Library revision conflict"
    );
    assert_ne!(
        read_library(&mut c).unwrap().bookmarks[0].title,
        "Stale edit"
    );
    assert_eq!(connector::revision(&c).unwrap(), next);
    assert!(apply_checked(&mut c, &patch, Some(&next)).is_ok());
    assert!(apply_checked(&mut c, &LibraryPatch::default(), None).is_ok());
}

fn smart(id: &str, rules: SmartRules) -> SmartCollection {
    SmartCollection {
        id: id.into(),
        name: format!("Smart {id}"),
        rules,
    }
}

#[test]
fn smart_persistence_defaults_and_incremental_revision() {
    let mut c = db();
    let mut legacy = serde_json::to_value(crate::tests::sample()).unwrap();
    legacy.as_object_mut().unwrap().remove("smartCollections");
    assert!(serde_json::from_value::<Library>(legacy)
        .unwrap()
        .smart_collections
        .is_empty());
    let empty: LibraryPatch = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(empty.smart_collections.is_empty());
    assert!(empty.deleted_smart_collection_ids.is_empty());
    let before = connector::revision(&c).unwrap();
    let mut patch = LibraryPatch {
        smart_collections: vec![smart(
            "s1",
            SmartRules {
                text: "Rust".into(),
                tags: vec!["work".into()],
                domain: "example.com".into(),
                untagged: false,
                inbox: true,
            },
        )],
        ..Default::default()
    };
    let revision = apply_checked(&mut c, &patch, Some(&before)).unwrap();
    assert_ne!(revision, before);
    assert_eq!(
        apply_checked(&mut c, &patch, Some(&revision)).unwrap(),
        revision
    );
    let library = read_library(&mut c).unwrap();
    assert_eq!(library.smart_collections, patch.smart_collections);
    initialize(&c).unwrap();
    assert_eq!(read_library(&mut c).unwrap(), library);
    write_library(&mut c, &library).unwrap();
    assert_eq!(read_library(&mut c).unwrap(), library);
    let backup: Library = serde_json::from_str(&serde_json::to_string(&library).unwrap()).unwrap();
    assert_eq!(backup, library);
    patch.smart_collections[0].name = "Changed".into();
    let revision = connector::revision(&c).unwrap();
    assert!(apply_checked(&mut c, &patch, Some(&before)).is_err());
    assert_ne!(
        apply_checked(&mut c, &patch, Some(&revision)).unwrap(),
        revision
    );
    patch.deleted_smart_collection_ids = vec!["s1".into()];
    assert!(apply(&mut c, &patch).is_err());
    patch.smart_collections.clear();
    apply(&mut c, &patch).unwrap();
    assert!(read_library(&mut c).unwrap().smart_collections.is_empty());
    patch.smart_collections = vec![smart(" ", SmartRules::default())];
    assert!(apply(&mut c, &patch).is_err());
    let mut invalid = library;
    invalid
        .smart_collections
        .push(smart("s1", SmartRules::default()));
    assert!(write_library(&mut c, &invalid).is_err());
    assert!(read_library(&mut c).unwrap().smart_collections.is_empty());
}

fn input(view: &str) -> QueryInput {
    QueryInput {
        view: view.into(),
        tag: String::new(),
        query: String::new(),
        domain: String::new(),
        sort: "newest".into(),
        page: 0,
    }
}

#[test]
fn smart_predicates_are_anded_and_text_is_combined_ascii_only() {
    let mut c = db();
    let mut b = bookmark(1);
    b.title = "CAF\u{c9} Rust".into();
    b.url = "https://WWW.Example.COM./path".into();
    b.description = "Notes".into();
    b.tags = vec!["work".into(), "rust".into()];
    b.collection_ids.clear();
    apply(
        &mut c,
        &LibraryPatch {
            bookmarks: vec![b],
            smart_collections: vec![smart(
                "s",
                SmartRules {
                    text: " rust HTTPS://www.example.com./path Notes work rust ".into(),
                    tags: vec!["work".into(), "rust".into()],
                    domain: "WWW.EXAMPLE.COM.".into(),
                    inbox: true,
                    ..Default::default()
                },
            )],
            ..Default::default()
        },
    )
    .unwrap();
    let count =
        |c: &mut Connection, input: &QueryInput| query_rows(c, input, None).unwrap().0.total;
    let mut i = input("smart:s");
    assert_eq!(count(&mut c, &i), 1);
    i.query = " RUST HTTPS://www.example.com./path ".into();
    i.tag = "rust".into();
    i.domain = "www.EXAMPLE.com.".into();
    assert_eq!(count(&mut c, &i), 1);
    for (field, value) in [
        ("tag", "Rust"),
        ("query", "caf\u{e9}"),
        ("domain", "other.example"),
    ] {
        let mut wrong = input("smart:s");
        match field {
            "tag" => wrong.tag = value.into(),
            "query" => wrong.query = value.into(),
            _ => wrong.domain = value.into(),
        }
        assert_eq!(count(&mut c, &wrong), 0, "{field}");
    }
    i.query = " caf\u{c9} ".into();
    assert_eq!(count(&mut c, &i), 1);
    assert_eq!(count(&mut c, &input("smart:missing")), 0);
    assert_eq!(
        count(
            &mut c,
            &QueryInput {
                query: "Notes work rust".into(),
                ..input("all")
            }
        ),
        1
    );
    for rules in [
        SmartRules {
            tags: vec!["missing".into()],
            ..Default::default()
        },
        SmartRules {
            untagged: true,
            ..Default::default()
        },
        SmartRules {
            domain: "ample.com".into(),
            ..Default::default()
        },
    ] {
        apply(
            &mut c,
            &LibraryPatch {
                smart_collections: vec![smart("s", rules)],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(count(&mut c, &input("smart:s")), 0);
    }
    let mut b = bookmark(3);
    b.tags.clear();
    b.collection_ids.clear();
    apply(
        &mut c,
        &LibraryPatch {
            bookmarks: vec![b],
            smart_collections: vec![smart(
                "s",
                SmartRules {
                    untagged: true,
                    inbox: true,
                    ..Default::default()
                },
            )],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(count(&mut c, &input("smart:s")), 1);
    let mut b = bookmark(3);
    b.tags.clear();
    apply(
        &mut c,
        &LibraryPatch {
            bookmarks: vec![b],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(count(&mut c, &input("smart:s")), 0);
}

#[test]
fn smart_ids_span_pages_and_reject_stale_revisions() {
    let mut c = db();
    apply(
        &mut c,
        &LibraryPatch {
            bookmarks: (0..320).map(bookmark).collect(),
            smart_collections: vec![smart(
                "s",
                SmartRules {
                    tags: vec!["work".into()],
                    ..Default::default()
                },
            )],
            ..Default::default()
        },
    )
    .unwrap();
    let revision = connector::revision(&c).unwrap();
    for sort in ["newest", "domain", "title"] {
        let i = QueryInput {
            sort: sort.into(),
            ..input("smart:s")
        };
        let ids = query_rows(&mut c, &i, Some(&revision)).unwrap().1;
        assert_eq!(ids.len(), 160);
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 160);
        let mut paged = Vec::new();
        for page in 0..3 {
            let page_input = QueryInput {
                sort: sort.into(),
                page,
                ..input("smart:s")
            };
            paged.extend(
                query_rows(&mut c, &page_input, None)
                    .unwrap()
                    .0
                    .bookmarks
                    .into_iter()
                    .map(|b| b["id"].as_str().unwrap().to_string()),
            );
        }
        assert_eq!(ids, paged);
        let no_page = QueryInput {
            sort: sort.into(),
            page: i64::MAX,
            ..input("smart:s")
        };
        assert_eq!(
            query_rows(&mut c, &no_page, Some(&revision)).unwrap().1,
            ids
        );
    }
    apply(
        &mut c,
        &LibraryPatch {
            deleted_bookmark_ids: vec!["b000000".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        query_rows(&mut c, &input("smart:s"), Some(&revision)).unwrap_err(),
        "Library revision conflict"
    );
    let current = connector::revision(&c).unwrap();
    assert_eq!(
        query_rows(&mut c, &input("smart:s"), Some(&current))
            .unwrap()
            .1
            .len(),
        159
    );
    let old_input: QueryInput = serde_json::from_value(
        serde_json::json!({"view":"all","tag":"","query":"","sort":"newest","page":0}),
    )
    .unwrap();
    assert!(old_input.domain.is_empty());
}
