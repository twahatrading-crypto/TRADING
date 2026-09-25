"""Process safety: one bridge per port, one bridge instance, the right interpreter (handoff §2.7 a–c)."""
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import run_bridge  # noqa: E402
from tluxe_mt5_bridge.config import from_env  # noqa: E402
from tluxe_mt5_bridge.instance import InstanceLock  # noqa: E402
from tluxe_mt5_bridge.server import ExclusiveHTTPServer, serve  # noqa: E402
from tluxe_mt5_bridge.terminal import Terminal  # noqa: E402

TOKEN = "t" * 40


def cfg(port="0"):
    return from_env({"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_BRIDGE_PORT": port})


class ExclusiveBindTests(unittest.TestCase):
    def test_never_reuses_the_address(self):
        self.assertFalse(ExclusiveHTTPServer.allow_reuse_address)

    def test_a_second_bridge_on_the_same_port_fails_loudly(self):
        c = cfg()
        first = serve(c, Terminal(c, mt5_module=object()))
        try:
            port = first.server_address[1]
            c2 = cfg(str(port))
            with self.assertRaises(OSError):
                serve(c2, Terminal(c2, mt5_module=object())).server_close()
        finally:
            first.server_close()


class InstanceLockTests(unittest.TestCase):
    def test_only_one_instance_and_released_on_exit(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".bridge.lock"
            a = InstanceLock(p)
            self.assertTrue(a.acquire())
            b = InstanceLock(p)
            self.assertFalse(b.acquire())
            self.assertEqual(b.holder(), str(os.getpid()))
            a.release()
            self.assertTrue(b.acquire())
            b.release()

    def test_main_refuses_a_second_instance(self):
        lock = InstanceLock(run_bridge.HERE / ".bridge.lock")
        self.assertTrue(lock.acquire())
        try:
            env = {"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_BRIDGE_ALLOW_NO_MT5": "1", "TLUXE_BRIDGE_PORT": "0"}
            with mock.patch.dict(os.environ, env):
                self.assertEqual(run_bridge.main(), run_bridge.EXIT_DUPLICATE)
        finally:
            lock.release()


@unittest.skipIf(importlib.util.find_spec("MetaTrader5") is not None, "MetaTrader5 installed here")
class InterpreterTests(unittest.TestCase):
    def test_refuses_an_interpreter_without_metatrader5(self):
        env = {"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_BRIDGE_PORT": "0"}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("TLUXE_BRIDGE_ALLOW_NO_MT5", None)
            self.assertFalse(run_bridge.preflight_interpreter())
            self.assertEqual(run_bridge.main(), run_bridge.EXIT_INTERPRETER)

    def test_launcher_pins_the_venv_interpreter(self):
        cmd = (run_bridge.HERE / "start_bridge.cmd").read_text(encoding="utf-8")
        self.assertIn(r".venv\Scripts\python.exe", cmd)
        self.assertNotRegex(cmd, r'(?m)^\s*python\s')


if __name__ == "__main__":
    unittest.main()
