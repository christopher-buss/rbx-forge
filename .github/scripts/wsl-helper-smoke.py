"""Real WSL interop with an owned Windows fixture; never discovers Studio."""
import json
import pathlib
import subprocess
import sys
import tempfile
import time


def windows(path):
    return subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()


native = pathlib.Path(sys.argv[1]).resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="forge-wsl-capability-", dir=sys.argv[2]) as directory:
    helper = subprocess.Popen(
        [str(native / "forge-windows-helper.exe")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    serial = 0

    def request(op, **fields):
        global serial
        serial += 1
        helper.stdin.write(json.dumps(dict(id=str(serial), deadlineMs=int(time.time() * 1000) + 10000, op=op, **fields)) + "\n")
        helper.stdin.flush()
        reply = json.loads(helper.stdout.readline())
        assert reply["id"] == str(serial) and "error" not in reply, reply
        return reply["result"]

    pin = None
    try:
        identity = request("handshake", protocol=1)
        print(json.dumps(dict(handshake=identity)), flush=True)
        launched = request(
            "launch", program=windows(native / "forge-studio-fixture.exe"),
            args=[windows(pathlib.Path(directory) / "fixture.rbxl")],
            cwd=windows(directory), env={"FIXTURE_STUDIO_LOCK": "1"}, desktop="hidden",
        )
        pin = launched["pin"]
        deadline = time.monotonic() + 10
        while not (pathlib.Path(directory) / "fixture.rbxl.lock").exists():
            assert time.monotonic() < deadline, "owned fixture did not open its place"
            time.sleep(0.1)
        assert request("processStartTime", pid=launched["pid"]) == launched["startTime"]
        assert request("isAlive", pin=pin)
        assert request("desktop", pin=pin) == "hidden"
        assert request("requestClose", pin=pin)
        deadline = time.monotonic() + 10
        while request("isAlive", pin=pin):
            assert time.monotonic() < deadline, "owned fixture did not close"
            time.sleep(0.1)
        print(json.dumps(dict(lifecycle="passed", studio=launched)), flush=True)
    finally:
        if pin is not None:
            request("kill", pin=pin)
        helper.stdin.close()
        helper.wait(timeout=10)
