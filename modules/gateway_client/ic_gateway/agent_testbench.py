"""Host-human review bridge for agent-authored testbenches.

No approval operation is exported as a model tool. A host-confirmed Service
request signs one frozen invocation; transport uncertainty never creates a new
request key or causes an automatic resend.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import time
from urllib.parse import urlencode

HUMAN_ROUTE = '/api/simulation/onboarding/agent-tb/human-run'
BODY_FIELDS = ('intake_id', 'revision', 'draft_id', 'plan_id', 'review_id', 'review_digest')


from .platform_compat import is_owner_private_file


def review_key(key_file):
    from .service import check
    check(isinstance(key_file, (str, Path)) and Path(key_file).is_absolute(),
          'The installed host has no testbench review authority.', 'review_host_unavailable', 4)
    path_key = Path(key_file)
    try:
        check(is_owner_private_file(path_key),
              'The installed review authority is not a private regular file.', 'review_host_unavailable', 4)
        key = path_key.read_bytes()
    except OSError:
        check(False, 'The installed review authority is unavailable.', 'review_host_unavailable', 4)
    check(32 <= len(key) <= 128, 'Invalid installed review authority.', 'review_host_unavailable', 4)
    return key


def human_signature(key_file, path, raw, *, now=None):
    from .service import check
    check(path == HUMAN_ROUTE and isinstance(raw, bytes), 'Invalid human review dispatch')
    key = review_key(key_file)
    timestamp = str(int(time.time() if now is None else now))
    message = json.dumps(['ic.agent-tb.human-review.v1', 'POST', path,
                          hashlib.sha256(raw).hexdigest(), timestamp], separators=(',', ':')).encode()
    return timestamp + '.' + hmac.new(key, message, hashlib.sha256).hexdigest()


def is_agent_plan(session):
    return (session.get('prepared') or {}).get('recipe_id') == 'agent-testbench' or bool(session.get('agent_tb_review'))


def review_body(session, arguments):
    from .service import check, hexvalue
    review = session.get('agent_tb_review') or {}
    prepared = session.get('prepared') or {}
    check(isinstance(review, dict) and is_agent_plan(session), 'This intake has no frozen agent testbench review.', 'conflict', 3)
    check(session.get('intake_id') == arguments['intake_id'] and session.get('revision') == arguments['revision']
          and prepared.get('plan_id') == arguments['plan_id'], 'The testbench changed before review.', 'conflict', 3)
    body = {'intake_id': arguments['intake_id'], 'revision': arguments['revision'],
            'plan_id': arguments['plan_id'], **{k: review.get(k) for k in ('draft_id', 'review_id', 'review_digest')}}
    for key in ('plan_id', 'review_id', 'review_digest'):
        hexvalue(body[key], 64, key)
    check(isinstance(body['draft_id'], str) and 1 <= len(body['draft_id']) <= 180, 'Invalid frozen testbench draft')
    return body


def request_identity(service, arguments, connection):
    from .service import digest
    return digest([service.gateway.origin, connection, 'agent-testbench', arguments['intake_id'], arguments['plan_id']])


def existing_request(service, arguments, connection):
    from .service import check
    request_id = request_identity(service, arguments, connection)
    if not (service.state / 'requests' / (request_id + '.json')).exists():
        return None
    prior = service.saved('requests', request_id)
    check(prior.get('gateway') == service.gateway.origin and prior.get('connection_id') == connection
          and prior.get('operation') == 'onboarding_agent_tb_run'
          and all(prior.get('body', {}).get(key) == arguments[key] for key in ('intake_id', 'plan_id')),
          'Saved review belongs to another plan; preserve its original receipt.', 'conflict', 3)
    return service.public_receipt(prior)


def prepare_request(service, arguments, connection, session):
    from .service import atom, check, digest, Failure
    body = review_body(session, arguments)
    # A stable plan identifies one request even if a caller changes its local
    # conversation or attempts to supply a new execution key.
    request_id = request_identity(service, arguments, connection)
    frozen_arguments = {**body, 'connection_id': connection, 'source_sha256': session.get('source_sha256')}
    fingerprint = digest(['onboarding_agent_tb_run', frozen_arguments])
    path = service.state / 'requests' / (request_id + '.json')
    if path.exists():
        prior = service.saved('requests', request_id)
        check(prior['fingerprint'] == fingerprint, 'The original reviewed plan changed; preserve its receipt.', 'conflict', 3)
        return service.public_receipt(prior)
    full_review = service._onboarding_request('onboarding_agent_tb_review',
        {'intake_id': body['intake_id'], 'review_id': body['review_id']}, connection)
    check(full_review.get('schema') == 'ic.agent-tb.review.v1'
          and full_review.get('connection_id') == connection
          and all(full_review.get(k) == body[k] for k in BODY_FIELDS)
          and isinstance(full_review.get('snapshot'), dict),
          'The complete frozen review does not match this plan.', 'conflict', 3)
    snapshot_digest = hashlib.sha256(json.dumps(full_review['snapshot'], sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    check(snapshot_digest == body['review_digest'], 'Frozen review digest differs.', 'conflict', 3)
    try:
        review_key(service.config.get('onboarding_review_authority_key_file'))
    except Failure as error:
        review_url = service.gateway.origin + '/agent-tb/review?' + urlencode(
            {key: body[key] for key in ('intake_id', 'review_id')})
        raise Failure(error.code, 'This connection cannot resolve a native testbench review. Open its local human-review page.',
            error.exit_code, {'review_url': review_url, 'intake_id': body['intake_id'],
                             'review_id': body['review_id'], 'human_review_required': True}) from error
    record = {'schema': 'ic.workbench.request.v1', 'request_id': request_id, 'fingerprint': fingerprint,
              'gateway': service.gateway.origin, 'connection_id': connection, 'operation': 'onboarding_agent_tb_run',
              'arguments': frozen_arguments, 'route': HUMAN_ROUTE, 'body': body,
              'source_sha256': session.get('source_sha256'), 'source_commit': session['prepared']['source_commit'], 'review': full_review,
              'testbench': session.get('agent_tb'), 'state': 'pending_approval', 'created_at': time.time(),
              'automatic_retry': False, 'human_review_required': True}
    atom(path, record)
    return service.public_receipt(record)


def dispatch_reviewed(service, record):
    from .service import check, Failure
    connection = service._onboarding_health()
    check(connection == record['connection_id'], 'Review belongs to a different onboarding connection.', 'conflict', 3)
    current = service._onboarding_request('onboarding_session', {'intake_id': record['body']['intake_id']}, connection)
    body = review_body(current, record['arguments'])
    check(body == record['body'] and current.get('source_sha256') == record['source_sha256'],
          'Source, testbench, targets or dependency review changed; prepare a new review.', 'conflict', 3)
    check(service.config.get('onboarding_review_authority_key_file'), 'This installed host has no testbench review authority.', 'review_host_unavailable', 4)
    try:
        result = service.gateway.request(HUMAN_ROUTE, body, onboarding_entry='native_agent',
            onboarding_connection_id=connection, route_timeout=320,
            human_review_key_file=service.config.get('onboarding_review_authority_key_file'))
    except Failure as error:
        # Even HTTP 4xx can follow a reservation (for example a failed response
        # validation). Only the original submission lookup can settle dispatch.
        raise Failure(error.code, str(error), error.exit_code,
            {**error.details, 'review_dispatch_attempted': True}) from error
    check(isinstance(result, dict) and result.get('schema') == 'ic.onboarding.session.v1'
          and result.get('connection_id') == connection and result.get('intake_id') == body['intake_id'],
          'Human dispatch returned a different intake; reconcile the original plan.', 'onboarding_response_mismatch', 75)
    return result
