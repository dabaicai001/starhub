"""Isolated SSH fixture: report channel lifetime without running host commands."""
import json
import socket
import threading
import time

import paramiko


def report(**values):
    print(json.dumps(values), flush=True)


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED

    def check_channel_pty_request(self, channel, *args):
        return True

    def check_channel_shell_request(self, channel):
        channel.send(b"fixture$ ")
        return True

    def check_channel_exec_request(self, channel, command):
        text = command.decode()

        def run():
            report(event="exec", command=text)
            if text == "hold":
                channel.send(b"started\n")
                while not channel.closed:
                    time.sleep(0.01)
                report(event="closed", command=text)
            else:
                channel.send(b"still-connected\n")
                channel.send_exit_status(0)
                channel.close()

        threading.Thread(target=run, daemon=True).start()
        return True


def serve(client, key):
    transport = paramiko.Transport(client)
    transport.add_server_key(key)
    try:
        transport.start_server(server=Server())
        channels = []
        while transport.is_active():
            channel = transport.accept(1)
            if channel is not None:
                channels.append(channel)
    finally:
        transport.close()


key = paramiko.RSAKey.generate(2048)
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
report(port=listener.getsockname()[1])
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client, key), daemon=True).start()
