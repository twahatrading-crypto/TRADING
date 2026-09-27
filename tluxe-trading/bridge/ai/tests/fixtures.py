"""TEST DATA ONLY - a scripted stand-in for the OpenAI client (same `models.retrieve` / `responses.create` surface).
Never imported by the running backend; no network; the key below is a fake shaped like an OpenAI key."""
from __future__ import annotations

import threading
import types

import httpx2
import openai

from tluxe_ai_bridge.config import from_env

FAKE_KEY = "sk-proj-TESTONLYabcdefghijklmnopqrstuvwxyz0123456789"
TOKEN = "t" * 40
REQ = httpx2.Request("POST", "https://api.openai.com/v1/responses")


def cfg(**over):
    env = {"OPENAI_API_KEY": FAKE_KEY, "TLUXE_AI_TOKEN": TOKEN, **over}
    return from_env({k: v for k, v in env.items() if v is not None})


def status_error(cls, code: int, message: str = "error"):
    return cls(message, response=httpx2.Response(code, request=REQ), body=None)


class FakeResponse:
    def __init__(self, text: str, status: str = "completed", model: str = "gpt-5.5") -> None:
        self.output_text = text
        self.status = status
        self.model = model
        self.id = "resp_test"
        self.usage = types.SimpleNamespace(input_tokens=12, output_tokens=7)


class FakeOpenAI:
    """Records every call. `reply(input)` returns the answer text; `error` raises instead; `gate` blocks the call."""

    def __init__(self, reply=None, error: BaseException | None = None, model_error: BaseException | None = None, gate: threading.Event | None = None) -> None:
        self.calls: list[dict] = []
        self.model_checks = 0
        self._reply = reply or (lambda inp: f"echo: {inp[-1]['content']}")
        self.error = error
        self.model_error = model_error
        self.gate = gate
        outer = self

        class Models:
            def retrieve(self, model):
                outer.model_checks += 1
                if outer.model_error:
                    raise outer.model_error
                return types.SimpleNamespace(id=model)

        class Responses:
            def create(self, **kw):
                outer.calls.append(kw)
                if outer.gate is not None:
                    outer.gate.wait(5)
                if outer.error:
                    raise outer.error
                r = outer._reply(kw["input"])
                return r if isinstance(r, FakeResponse) else FakeResponse(r)

        self.models = Models()
        self.responses = Responses()


def factory(client: FakeOpenAI):
    def f(key, timeout_s):
        assert key.reveal() == FAKE_KEY  # the key reaches ONLY the client constructor
        return client

    return f


AUTH_ERR = lambda: status_error(openai.AuthenticationError, 401, "Incorrect API key provided: sk-proj-****")  # noqa: E731
NOT_FOUND = lambda: status_error(openai.NotFoundError, 404, "model not found")  # noqa: E731
RATE = lambda: status_error(openai.RateLimitError, 429, "quota")  # noqa: E731
TIMEOUT = lambda: openai.APITimeoutError(request=REQ)  # noqa: E731
CONN = lambda: openai.APIConnectionError(request=REQ)  # noqa: E731
