"""Tagging dependencies cannot authorize a policy or queue behavior change."""
import copy,json,unittest
from pathlib import Path
from ops.ci import release_guard

ROOT=Path(__file__).resolve().parents[2]


class PerformanceDependencyTests(unittest.TestCase):
    def test_reviewed_dynamic_causes_accept_only_exact_unchanged_references(self):
        dependencies=release_guard.load_release_dependencies(json.loads((ROOT/'ops/ci/release_dependencies.json').read_text()))
        intent=release_guard.load_release_intent(json.loads((ROOT/'ops/ci/release_intent.json').read_text()))
        reviewed=json.loads((ROOT/'ops/tests/fixtures/performance_tag_dependencies.json').read_text())['reviewed']
        self.assertEqual(len(reviewed),47)
        for item in reviewed:
            logical=item['logicalId'];prop=item['propertyPath'];cause=item['cause']
            keys=[key for key,causes in dependencies.items() if key[0]==logical and key[2]==prop and cause in causes]
            self.assertEqual(len(keys),1)
            typ=keys[0][1];recreation='Always' if prop=='EventSourceArn' else 'Never'
            change={'ResourceChange':{'Action':'Modify','LogicalResourceId':logical,'ResourceType':typ,'Replacement':'Conditional' if recreation=='Always' else 'False','Details':[{'Evaluation':'Dynamic','ChangeSource':'ResourceAttribute','CausingEntity':cause,'Target':{'Attribute':'Properties','Name':prop,'RequiresRecreation':recreation}}]}}
            with self.subTest(logical=logical,prop=prop,cause=cause):
                self.assertEqual(release_guard.gate_change_set([{'Changes':[change]}],release_intent=intent,release_dependencies=dependencies)['Modify'],1)
                for delta in [{'Evaluation':'Static'},{'ChangeSource':'DirectModification'},{'CausingEntity':'DifferentResource.Arn'}]:
                    wrong=copy.deepcopy(change);wrong['ResourceChange']['Details'][0].update(delta)
                    with self.assertRaises(release_guard.GateError):release_guard.gate_change_set([{'Changes':[wrong]}],release_intent=intent,release_dependencies=dependencies)
                wrong=copy.deepcopy(change);wrong['ResourceChange']['Replacement']='True'
                with self.assertRaises(release_guard.GateError):release_guard.gate_change_set([{'Changes':[wrong]}],release_intent=intent,release_dependencies=dependencies)
