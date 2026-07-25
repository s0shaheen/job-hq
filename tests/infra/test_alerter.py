"""The SNS -> ntfy alerter. Loaded by path (infra/alerter isn't a package), same as the
bots' handler test. Nothing here may touch the network: `_push` is exercised with urlopen
stubbed, so a green test run can never page anyone."""
import importlib.util
import json
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "infra" / "alerter" / "index.py"
_spec = importlib.util.spec_from_file_location("hq_alerter", _PATH)
a = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a)


def _alarm(state="ALARM", name="job-hq-bots-errors"):
    return json.dumps({"AlarmName": name, "NewStateValue": state,
                       "AlarmDescription": "a bot failed", "NewStateReason": "1 datapoint [1.0]"})


class _Resp:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *e): return False


@pytest.fixture
def sent(monkeypatch):
    """Records (url, body, headers) instead of POSTing."""
    calls = []
    def fake_urlopen(req, timeout=None):
        calls.append((req.full_url, req.data.decode(), dict(req.headers)))
        return _Resp()
    monkeypatch.setattr(a.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPS_NTFY_TOPIC", "ops-topic")
    monkeypatch.setenv("LOG_GROUP_URL", "https://console/logs")
    return calls


def test_alarm_state_pushes_high_priority_with_the_reason(sent):
    a.handler({"Records": [{"Sns": {"Message": _alarm()}}]}, None)
    url, body, headers = sent[0]
    assert url == "https://ntfy.sh/ops-topic"
    assert "job-hq-bots-errors" in headers["Title"] and "ALARM" in headers["Title"]
    assert headers["Priority"] == "high" and headers["Tags"] == "warning"
    assert "a bot failed" in body and "1 datapoint" in body
    assert headers["Click"] == "https://console/logs"


def test_ok_state_pushes_a_low_priority_recovery(sent):
    a.handler({"Records": [{"Sns": {"Message": _alarm(state="OK")}}]}, None)
    _, _, headers = sent[0]
    assert "recovered" in headers["Title"]
    assert headers["Priority"] == "default" and headers["Tags"] == "white_check_mark"


def test_non_alarm_payloads_still_reach_the_phone(sent):
    # `aws sns publish --message "hi"` and a direct test invoke must both push, not crash
    a.handler({"Records": [{"Sns": {"Message": "hand-published test"}}]}, None)
    a.handler({"hello": "direct invoke"}, None)
    assert [c[1] for c in sent] == ["hand-published test", '{"hello": "direct invoke"}']
    assert all(h["Priority"] == "high" for _, _, h in sent)


def test_every_record_is_pushed_and_counted(sent):
    out = a.handler({"Records": [{"Sns": {"Message": _alarm()}},
                                 {"Sns": {"Message": _alarm(name="job-hq-bots-silent")}}]}, None)
    assert out == {"pushed": 2} and len(sent) == 2


def test_missing_topic_fails_loud(monkeypatch):
    monkeypatch.delenv("OPS_NTFY_TOPIC", raising=False)
    with pytest.raises(KeyError):        # misconfigured alerter must not look healthy
        a.handler({"Records": [{"Sns": {"Message": _alarm()}}]}, None)


def test_emoji_in_an_alarm_name_cannot_crash_the_send(sent):
    a.handler({"Records": [{"Sns": {"Message": _alarm(name="job-hq-🔥")}}]}, None)
    sent[0][2]["Title"].encode("latin-1")      # http.client would raise otherwise
