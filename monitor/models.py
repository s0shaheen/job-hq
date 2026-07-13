from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class Job:
    ats: str
    native_id: str
    company: str
    title: str
    location: str
    url: str
    posted: str = ""

    @property
    def id(self) -> str:
        return f"{self.ats}-{self.native_id}"

    def to_record(self, status: str, today: str) -> "JobRecord":
        return JobRecord(
            id=self.id, company=self.company, title=self.title,
            location=self.location, url=self.url, status=status,
            first_seen=today, last_seen=today, posted=self.posted,
        )


@dataclass
class JobRecord:
    id: str
    company: str
    title: str
    location: str
    url: str
    status: str
    first_seen: str
    last_seen: str
    posted: str = ""


@dataclass
class Company:
    name: str
    ats: str
    slug: str
    monitor: bool = True
    seeded: bool = False
    priority: bool = False   # Companies-tab flag: alert-worthy regardless of YoE


@dataclass
class ReconcileResult:
    new_records: list[JobRecord] = field(default_factory=list)
    seed_records: list[JobRecord] = field(default_factory=list)
    reopened_ids: list[str] = field(default_factory=list)
    touched_ids: list[str] = field(default_factory=list)
    closed_ids: list[str] = field(default_factory=list)
