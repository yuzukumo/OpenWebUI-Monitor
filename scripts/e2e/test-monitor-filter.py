#!/usr/bin/env python3

import asyncio
import importlib.util
import sys
import types
from pathlib import Path


class StubBaseModel:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


def stub_field(default=None, **_kwargs):
    return default


class FakeAsyncClient:
    def __init__(self, *_args, **_kwargs):
        self.closed = False

    async def aclose(self):
        self.closed = True


def load_monitor_module():
    httpx_module = types.ModuleType("httpx")
    httpx_module.AsyncClient = FakeAsyncClient
    pydantic_module = types.ModuleType("pydantic")
    pydantic_module.BaseModel = StubBaseModel
    pydantic_module.Field = stub_field

    sys.modules["httpx"] = httpx_module
    sys.modules["pydantic"] = pydantic_module

    module_path = (
        Path(__file__).resolve().parents[2]
        / "resources"
        / "functions"
        / "openwebui_monitor.py"
    )
    spec = importlib.util.spec_from_file_location("openwebui_monitor_test", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load OpenWebUI Monitor filter")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def main():
    module = load_monitor_module()
    monitor = module.Filter()
    user = {"id": "filter-test-user"}
    successful_body = {
        "model": "image-model",
        "messages": [
            {"role": "user", "content": "Generate an image"},
            {
                "role": "assistant",
                "content": "![image](https://example.com/image.png)",
                "usage": {
                    "input_tokens": 7,
                    "output_tokens": 0,
                    "total_tokens": 7,
                },
            },
        ],
    }

    monitor_requests = []

    async def fake_request(*, client, url, headers, json_data):
        monitor_requests.append(
            {
                "client": client,
                "url": url,
                "headers": headers,
                "json_data": json_data,
            }
        )
        return {
            "success": True,
            "inputTokens": 7,
            "outputTokens": 0,
            "totalCost": 0.02,
            "newBalance": 9.98,
        }

    monitor.request = fake_request

    failed_metadata = {}
    error_event = {"error": {"detail": "intentional upstream failure"}}
    returned_event = await monitor.stream(error_event, failed_metadata)
    assert returned_event is error_event
    assert failed_metadata[module.FAILED_REQUEST_METADATA_KEY] is True

    returned_body = await monitor.outlet(
        successful_body,
        __metadata__=failed_metadata,
        __user__=user,
    )
    assert returned_body is successful_body
    assert monitor_requests == []

    failed_response_metadata = {}
    await monitor.stream({"type": "response.failed"}, failed_response_metadata)
    await monitor.outlet(
        successful_body,
        __metadata__=failed_response_metadata,
        __user__=user,
    )
    assert monitor_requests == []

    nested_failure_metadata = {}
    await monitor.stream(
        {"type": "response.done", "response": {"status": "failed"}},
        nested_failure_metadata,
    )
    assert nested_failure_metadata[module.FAILED_REQUEST_METADATA_KEY] is True

    nullable_error_metadata = {}
    await monitor.stream(
        {"type": "response.completed", "error": None},
        nullable_error_metadata,
    )
    assert module.FAILED_REQUEST_METADATA_KEY not in nullable_error_metadata

    nonterminal_event_metadata = {}
    await monitor.stream(
        {"type": "tool:error", "data": {"message": "tool fallback used"}},
        nonterminal_event_metadata,
    )
    assert module.FAILED_REQUEST_METADATA_KEY not in nonterminal_event_metadata

    successful_metadata = {}
    success_event = {
        "choices": [
            {
                "delta": {"content": "generated image"},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "input_tokens": 7,
            "output_tokens": 0,
            "total_tokens": 7,
        },
    }
    await monitor.stream(success_event, successful_metadata)
    await monitor.outlet(
        successful_body,
        __metadata__=successful_metadata,
        __user__=user,
    )

    assert len(monitor_requests) == 1
    sent_usage = monitor_requests[0]["json_data"]["body"]["messages"][-1][
        "usage"
    ]
    assert sent_usage["output_tokens"] == 0

    explicit_error_body = {
        "model": "image-model",
        "messages": [
            {"role": "user", "content": "Generate an image"},
            {"role": "assistant", "error": {"detail": "failed"}},
        ],
    }
    await monitor.outlet(explicit_error_body, __metadata__={}, __user__=user)
    assert len(monitor_requests) == 1

    print("OpenWebUI Monitor filter billing-state checks passed")


if __name__ == "__main__":
    asyncio.run(main())
