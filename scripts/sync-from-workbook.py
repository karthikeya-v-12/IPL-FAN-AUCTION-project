#!/usr/bin/env python3
"""Sync team purses from workbook and organize local player portrait files."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PUBLIC_IMAGES = ROOT / "public" / "player-images"
WORKBOOK = Path(
    r"C:\Users\hasin\Downloads\ipl_2027_fan_made_auction_database_with_release_purse_recalculation.xlsx"
)

ALIAS = {
    "dhoni": "MS Dhoni",
    "anshul": "Anshul Kamboj",
    "ms dhoni": "MS Dhoni",
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load_player_names() -> dict[str, str]:
    names: set[str] = set()
    squads = json.loads((DATA / "initial-squads.json").read_text(encoding="utf-8"))
    for players in squads.values():
        for p in players:
            names.add(p["name"])
    for p in json.loads((DATA / "candidates.json").read_text(encoding="utf-8")):
        names.add(p["name"])
    by_slug = {slug(n): n for n in names}
    by_lower = {n.lower(): n for n in names}
    return by_slug, by_lower, names


def match_name(stem: str, by_slug: dict, by_lower: dict) -> str | None:
    key = stem.strip()
    if key.lower() in ALIAS:
        return ALIAS[key.lower()]
    s = slug(key)
    if s in by_slug:
        return by_slug[s]
    if key.lower() in by_lower:
        return by_lower[key.lower()]
    # first-name only when unique
    parts = re.split(r"\s+", key.lower())
    if len(parts) == 1:
        hits = [n for n in by_lower.values() if n.lower().startswith(parts[0] + " ") or n.lower().split()[0] == parts[0]]
        if len(hits) == 1:
            return hits[0]
    return None


def update_teams() -> None:
    wb = openpyxl.load_workbook(WORKBOOK, data_only=True)
    ws = wb["2027 Purse Model"]
    excel_by_id: dict[str, dict] = {}
    for r in range(5, ws.max_row + 1):
        team_id = ws.cell(r, 1).value
        if not team_id or not isinstance(team_id, str) or len(team_id) > 5:
            continue
        post_release = ws.cell(r, 10).value
        if post_release is None:
            continue
        excel_by_id[team_id] = {
            "releaseCreditCr": round(float(ws.cell(r, 9).value or 0), 2),
            "postReleasePurseCr": round(float(post_release), 2),
            "sourceRemainingCr": round(float(ws.cell(r, 3).value or 0), 2),
            "tradeAdjustmentCr": round(float(ws.cell(r, 6).value or 0), 2),
        }

    teams = json.loads((DATA / "teams.json").read_text(encoding="utf-8"))
    for team in teams:
        row = excel_by_id.get(team["id"])
        if not row:
            continue
        pre_trade = round(row["sourceRemainingCr"] + 5 + row["tradeAdjustmentCr"], 2)
        team["sourceRemainingCr"] = row["sourceRemainingCr"]
        team["tradeAdjustmentCr"] = row["tradeAdjustmentCr"]
        team["purseBaseBeforeTradeCr"] = pre_trade
        team["releaseCreditCr"] = row["releaseCreditCr"]
        team["basePurseCr"] = row["postReleasePurseCr"]
    (DATA / "teams.json").write_text(json.dumps(teams, indent=2) + "\n", encoding="utf-8")
    print("Updated teams.json purses:", {t["id"]: t["basePurseCr"] for t in teams})


def organize_images() -> None:
    by_slug, by_lower, _ = load_player_names()
    PUBLIC_IMAGES.mkdir(parents=True, exist_ok=True)

    sources: list[Path] = []
    sources.extend(
        p
        for p in ROOT.iterdir()
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )

    copied: dict[str, str] = {}
    unmatched: list[str] = []
    for src in sorted(sources, key=lambda p: p.name.lower()):
        name = match_name(src.stem, by_slug, by_lower)
        if not name:
            unmatched.append(src.name)
            continue
        dest_base = slug(name)
        ext = src.suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
        dest = PUBLIC_IMAGES / f"{dest_base}{ext}"
        shutil.copy2(src, dest)
        copied[name] = f"/player-images/{dest_base}{ext}"
        try:
            src.unlink()
        except OSError:
            pass

    squads = json.loads((DATA / "initial-squads.json").read_text(encoding="utf-8"))
    updated = 0
    for players in squads.values():
        for p in players:
            if p["name"] in copied:
                p["image"] = copied[p["name"]]
                updated += 1
    (DATA / "initial-squads.json").write_text(json.dumps(squads, indent=2) + "\n", encoding="utf-8")

    manifest_path = ROOT / "ipl_2027_current_squad_image_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("players", []):
            if entry.get("playerName") in copied:
                entry["imageUrl"] = copied[entry["playerName"]]
                entry["status"] = "local user-supplied portrait in public/player-images"
                entry["provider"] = "User local PNG"
        manifest["localImageAssetCount"] = len(list(PUBLIC_IMAGES.glob("*")))
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"Copied {len(copied)} portraits into public/player-images; updated {updated} squad rows.")
    if unmatched:
        print("Unmatched root files:", unmatched)


if __name__ == "__main__":
    update_teams()
    organize_images()
