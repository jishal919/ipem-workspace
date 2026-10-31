import getpass, sys

def custom_getpass(prompt='', stream=None):
    if prompt:
        sys.stderr.write(prompt)
        sys.stderr.flush()
    return sys.stdin.readline().rstrip('\r\n')

getpass.getpass = custom_getpass
