"""Nonsecret connection descriptions. Reading this never starts an agent or MCP server."""
from pathlib import Path


def describe_connection(config):
    result = {
        'schema': 'ic.agent.connection.v1',
        'chat': {'transport': 'codex-app-server', 'tools': 'dynamic-tools',
                 'status': 'configured', 'inferenceVerified': False},
        'mcp': {'transport': 'stdio', 'status': 'unconfigured',
                'command': None, 'args': [], 'verified': False},
        'notes': ['MCP provides project tools and resources; it does not replace the chat session protocol.',
                  'Configuration availability does not prove a connected agent or a completed model turn.'],
    }
    profile = config.get('mcp_connection')
    if not profile:
        return result
    # Only explicit executable / entry / local settings paths are described. Never
    # serialize service configuration, environment values, credentials or arbitrary args.
    if not isinstance(profile, dict) or set(profile) not in (
            {'python', 'server', 'config'}, {'python', 'server', 'settings'}):
        result['notes'].append('The local MCP connection profile is invalid.')
        return result
    for value in profile.values():
        if (not isinstance(value, str) or not value or len(value) > 4096
                or any(ord(c) < 32 for c in value) or not Path(value).is_absolute()
                or not Path(value).is_file()):
            result['notes'].append('A required local MCP runtime or configuration file is unavailable.')
            return result
    option = 'config' if 'config' in profile else 'settings'
    result['mcp'].update(status='prepared', command=profile['python'],
                         args=['-B', profile['server'], '--' + option, profile[option]])
    return result
