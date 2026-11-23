"""Real Gateway HTTP flow with a fake monotonic clock; no sockets or retries."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'modules/gateway_client'))
from ic_gateway.service import Failure, Gateway, canonical


CONNECTION = 'c'*32
PATH = '/api/simulation/onboarding/discover-pdk'
HEALTH = {'api_version':'1','mode':'live','mutation_token':'synthetic-only',
    'connection_id':CONNECTION,'capabilities':{'simulation_onboarding':True,
        'simulation_onboarding_native_entry':True,'simulation_onboarding_api_version':'1'}}


class Clock:
    now = 1000.0
    def __call__(self):return self.now


class Exchange:
    def __init__(self,clock,*,health_cost=0,route_costs=(0,0,0),health_error=None,health_status=200):
        self.clock=clock;self.health_cost=health_cost;self.route_costs=route_costs
        self.health_error=health_error;self.health_status=health_status
        self.connections=[];self.requests=[];self.read_timeouts=[]

    def connection(self,*args,timeout):
        owner=self
        class Socket:
            def settimeout(self,value):self.timeout=value
        class Response:
            def __init__(self,conn):
                self.conn=conn;self.health=conn.path=='/api/health'
                self.status=owner.health_status if self.health else 200
                data=HEALTH if self.health else {'result':'synthetic-only'}
                self.raw=canonical({'ok':True,'data':data}).encode();self.offset=0
            def read1(self,size):
                owner.read_timeouts.append((self.conn.path,self.conn.sock.timeout))
                owner.clock.now+=owner.health_cost if self.health else owner.route_costs[2]
                if self.health and owner.health_error:raise owner.health_error
                # Multiple route chunks exercise deadline renewal between reads.
                size=min(size,12) if not self.health else size
                out=self.raw[self.offset:self.offset+size];self.offset+=len(out)
                return out
            def read(self,size):
                owner.clock.now+=owner.health_cost if self.health else owner.route_costs[2]
                if self.health and owner.health_error:raise owner.health_error
                return self.raw[:size]
        class Connection:
            def __init__(self):
                self.timeout=timeout;self.created_timeout=timeout;self.closed=False;self.sock=Socket()
                self.sock.settimeout(timeout);owner.connections.append(self)
            def request(self,method,path,body=None,headers=None):
                self.path=path;owner.requests.append((method,path,self.timeout,headers))
                if path!='/api/health':owner.clock.now+=owner.route_costs[0]
            def getresponse(self):
                if self.path!='/api/health':owner.clock.now+=owner.route_costs[1]
                return Response(self)
            def close(self):self.closed=True
        return Connection()


class OnboardingDeadlineTests(unittest.TestCase):
    def invoke(self,exchange,*,configured=30,budget=300,**kwargs):
        with (patch('ic_gateway.service.time.monotonic',exchange.clock),
              patch('ic_gateway.service.http.client.HTTPConnection',side_effect=exchange.connection)):
            return Gateway('http://127.0.0.1:18884',timeout=configured).request(PATH,{'synthetic':True},
                onboarding_entry='native_agent',onboarding_connection_id=CONNECTION,
                route_timeout=budget,**kwargs)

    def test_health_elapsed_is_deducted_before_single_mutation_dispatch(self):
        clock=Clock();exchange=Exchange(clock,health_cost=11.5)
        self.assertEqual(self.invoke(exchange),{'result':'synthetic-only'})
        # The second health read is EOF; both actual read costs count.
        self.assertEqual([row[1] for row in exchange.requests],['/api/health',PATH])
        self.assertEqual(exchange.connections[0].created_timeout,30)
        self.assertEqual(exchange.connections[1].created_timeout,277)
        self.assertEqual(exchange.requests[1][2],277)
        self.assertTrue(all(conn.closed for conn in exchange.connections))

    def test_health_is_capped_by_configured_timeout_and_remaining_route_budget(self):
        for configured,budget,expected in ((120,300,120),(120,5,5),(30,300,30)):
            with self.subTest(configured=configured,budget=budget):
                exchange=Exchange(Clock())
                self.invoke(exchange,configured=configured,budget=budget)
                self.assertEqual(exchange.connections[0].created_timeout,expected)

    def test_health_budget_exhaustion_never_sends_mutation_and_never_retries(self):
        exchange=Exchange(Clock(),health_cost=5)
        with self.assertRaises(Failure) as caught:self.invoke(exchange,configured=120,budget=5)
        self.assertEqual(caught.exception.exit_code,75)
        self.assertFalse(caught.exception.details['request_dispatched'])
        self.assertEqual([row[:2] for row in exchange.requests],[('GET','/api/health')])
        self.assertEqual(len(exchange.connections),1);self.assertTrue(exchange.connections[0].closed)

    def test_health_transport_failure_never_sends_mutation(self):
        exchange=Exchange(Clock(),health_error=OSError('synthetic health failure'))
        with self.assertRaises(Failure) as caught:self.invoke(exchange)
        self.assertEqual(caught.exception.code,'transport_unknown')
        self.assertFalse(caught.exception.details['request_dispatched'])
        self.assertEqual([row[:2] for row in exchange.requests],[('GET','/api/health')])
        self.assertEqual(len(exchange.connections),1)

    def test_operation_body_reduces_remaining_budget_and_stops_without_replay(self):
        exchange=Exchange(Clock(),route_costs=(1,2,1))
        with self.assertRaises(Failure) as caught:self.invoke(exchange,budget=5)
        self.assertEqual(caught.exception.code,'transport_unknown')
        self.assertTrue(caught.exception.details['request_dispatched'])
        self.assertEqual([value for path,value in exchange.read_timeouts if path==PATH],[2,1])
        self.assertEqual([row[1] for row in exchange.requests],['/api/health',PATH])
        self.assertTrue(all(conn.closed for conn in exchange.connections))

    def test_subsecond_remainder_is_passed_without_resetting_to_configured_timeout(self):
        exchange=Exchange(Clock(),health_cost=.375)
        self.invoke(exchange,budget=1)
        self.assertEqual(exchange.connections[1].created_timeout,.25)

    def test_other_routes_and_implicit_onboarding_keep_original_health_semantics(self):
        for path,kwargs,expected in (
            ('/api/ordinary',{'route_timeout':300},300),
            (PATH,{'onboarding_connection_id':CONNECTION},120)):
            with self.subTest(path=path):
                exchange=Exchange(Clock(),health_cost=23)
                with (patch('ic_gateway.service.time.monotonic',exchange.clock),
                      patch('ic_gateway.service.http.client.HTTPConnection',side_effect=exchange.connection)):
                    Gateway('http://127.0.0.1:18884',timeout=120).request(path,{'synthetic':True},**kwargs)
                self.assertEqual(exchange.connections[0].created_timeout,120)
                self.assertEqual(exchange.connections[1].created_timeout,expected)
                self.assertEqual(len(exchange.requests),2)


if __name__=='__main__':unittest.main()
