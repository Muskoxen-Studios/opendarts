import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import train_real_presence_v6 as trainer


def metrics(positive_fn, real_fp):
    return {'positiveFalseNegativesAtHalf': positive_fn, 'realFalsePositivesAtHalf': real_fp,
            'positivePairs': {'errorRateAtHalf': positive_fn / 100},
            'realEmptyPairs': {'errorRateAtHalf': real_fp / 100},
            'syntheticEmptyPairs': {'errorRateAtHalf': 0.0}}


class V6RetentionSelectionTests(unittest.TestCase):
    def setUp(self):
        self.old_incumbent = metrics(1, 2)
        self.new_incumbent = metrics(2, 0)

    def test_guard_rejects_gain_that_regresses_either_cohort(self):
        candidate = {'historical': metrics(0, 2), 'expansion': metrics(3, 0)}
        feasible, failures = trainer.retention_guard(candidate, self.old_incumbent, self.new_incumbent)
        self.assertFalse(feasible)
        self.assertEqual(failures, [{'split': 'expansion', 'metric': 'positiveFalseNegativesAtHalf',
                                    'actual': 3, 'maximum': 2}])

    def test_guard_rejects_extra_real_false_positive_on_old_cohort(self):
        candidate = {'historical': metrics(1, 3), 'expansion': metrics(2, 0)}
        feasible, failures = trainer.retention_guard(candidate, self.old_incumbent, self.new_incumbent)
        self.assertFalse(feasible)
        self.assertEqual(failures[0]['metric'], 'realFalsePositivesAtHalf')
        self.assertEqual(failures[0]['split'], 'historical')

    def test_selection_falls_back_to_v4_when_all_new_epochs_violate_guard(self):
        incumbent = {'name': 'v4-incumbent', 'epoch': 0, 'feasible': True,
                     'combinedPositiveFalseNegatives': 3, 'combinedRealFalsePositives': 2,
                     'validationBce': .4}
        rejected = {'name': 'v6-epoch', 'epoch': 11, 'feasible': False,
                    'combinedPositiveFalseNegatives': 1, 'combinedRealFalsePositives': 0,
                    'validationBce': .2}
        self.assertIs(trainer.select_candidate([incumbent, rejected]), incumbent)

    def test_feasible_candidate_rank_is_positive_fn_then_real_fp_then_bce(self):
        incumbent = {'name': 'v4-incumbent', 'epoch': 0, 'feasible': True,
                     'combinedPositiveFalseNegatives': 3, 'combinedRealFalsePositives': 2,
                     'validationBce': .4}
        fewer_fn = {'name': 'v6-epoch', 'epoch': 8, 'feasible': True,
                    'combinedPositiveFalseNegatives': 2, 'combinedRealFalsePositives': 5,
                    'validationBce': .8}
        lower_fp = {'name': 'v6-epoch', 'epoch': 9, 'feasible': True,
                    'combinedPositiveFalseNegatives': 3, 'combinedRealFalsePositives': 1,
                    'validationBce': .1}
        self.assertIs(trainer.select_candidate([incumbent, lower_fp, fewer_fn]), fewer_fn)


if __name__ == '__main__':
    unittest.main()
