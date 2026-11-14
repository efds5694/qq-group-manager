"""配置读写：profiles、批量默认参数、群设置模板。

写入统一走原子替换，避免改配置时断电留下坏文件。
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from .core import store

CONFIG_PATH = store.BASE_DIR / "config.json"

DEFAULT_PROFILE = {
    "name": "NapCat",
    "base_url": "http://127.0.0.1:3000",
    "token": "",
    "adapter": "napcat",
}

DEFAULTS: dict[str, Any] = {
    "active_profile": DEFAULT_PROFILE["name"],
    "profiles": [copy.deepcopy(DEFAULT_PROFILE)],
    "batch": {
        "interval": 2.0,
        "retries": 2,
        "trial_size": 10,
        "min_interval": 0.8,
        "max_interval": 10.0,
    },
    "templates": [],
    "server": {"host": "127.0.0.1", "port": 8787},
}


def _merge(base: dict, override: dict) -> dict:
    """只做一层深合并，足够覆盖配置结构。"""
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def load() -> dict:
    raw = store.read_json(CONFIG_PATH, {}) or {}
    config = _merge(DEFAULTS, raw)

    if not isinstance(config.get("profiles"), list) or not config["profiles"]:
        config["profiles"] = [copy.deepcopy(DEFAULT_PROFILE)]

    for profile in config["profiles"]:
        for key, value in DEFAULT_PROFILE.items():
            profile.setdefault(key, value)

    names = [profile["name"] for profile in config["profiles"]]
    if config.get("active_profile") not in names:
        config["active_profile"] = names[0]

    return config


def save(config: dict) -> None:
    store.write_json(CONFIG_PATH, config)


def active_profile(config: dict) -> dict:
    name = config.get("active_profile")
    for profile in config["profiles"]:
        if profile.get("name") == name:
            return profile
    return config["profiles"][0]


def upsert_profile(config: dict, profile: dict) -> dict:
    name = (profile.get("name") or "").strip() or "NapCat"
    entry = {
        "name": name,
        "base_url": (profile.get("base_url") or DEFAULT_PROFILE["base_url"]).rstrip("/"),
        "token": (profile.get("token") or "").strip(),
        "adapter": profile.get("adapter") or "napcat",
    }

    existing = None
    for item in config["profiles"]:
        if item.get("name") == name:
            existing = item
            break

    if existing is None:
        config["profiles"].append(entry)
    else:
        # 前端不回传 token 时（留空）视为「不修改」
        if not entry["token"]:
            entry["token"] = existing.get("token", "")
        existing.update(entry)

    config["active_profile"] = name
    save(config)
    return config


def public_view(config: dict) -> dict:
    """给前端的配置视图：token 只回传是否已配置。"""
    profiles = [
        {
            "name": item["name"],
            "base_url": item["base_url"],
            "adapter": item.get("adapter", "napcat"),
            "has_token": bool(item.get("token")),
        }
        for item in config["profiles"]
    ]
    active = active_profile(config)
    return {
        "active_profile": config.get("active_profile"),
        "active": {
            "name": active["name"],
            "base_url": active["base_url"],
            "adapter": active.get("adapter", "napcat"),
            "has_token": bool(active.get("token")),
        },
        "profiles": profiles,
        "batch": config.get("batch", {}),
        "server": config.get("server", {}),
        "templates": config.get("templates", []),
    }


def save_template(config: dict, template: dict) -> dict:
    template = dict(template)
    template["id"] = template.get("id") or f"tpl-{len(config.get('templates', [])) + 1}"
    templates = [item for item in config.get("templates", []) if item.get("id") != template["id"]]
    templates.append(template)
    config["templates"] = templates
    save(config)
    return template


def delete_template(config: dict, template_id: str) -> None:
    config["templates"] = [item for item in config.get("templates", []) if item.get("id") != template_id]
    save(config)


def path() -> Path:
    return CONFIG_PATH
