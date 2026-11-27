CREATE TABLE minute_events (
    minute INTEGER NOT NULL CHECK (minute >= 0),
    event TEXT NOT NULL CHECK (event IN ('go_open', 'go_click_open', 'go_click_copy', 'site_open')),
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (minute, event)
) WITHOUT ROWID;

CREATE TABLE coverage (
    source TEXT PRIMARY KEY CHECK (source IN ('go', 'site')),
    minute INTEGER NOT NULL CHECK (minute >= 0)
) WITHOUT ROWID;
