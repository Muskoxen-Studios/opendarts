"""Bounded pixel/geometry tuning; protocol and occupancy invariants are not tunable.

Units are explicit in field names. Bounds limit search cost and implausible fits;
valid values are not a promise of detection accuracy. Evaluate on held-out images.
"""

import math
from dataclasses import asdict, dataclass, fields
from types import MappingProxyType


# Inclusive bounds, also usable by offline evaluators/tuners as a search space.
PARAMETER_BOUNDS = MappingProxyType({
    'difference_threshold_gray': (1, 64),
    'blob_threshold_gray': (1, 128),
    'max_changed_fraction': (0.001, 0.08),
    'min_blob_pixels': (3, 64),
    'max_shaft_width_px': (2.0, 16.0),
    'hough_sample_target': (100, 1200),
    'hough_angle_step_deg': (1, 10),
    'hough_rho_bin_px': (1.0, 4.0),
    'hough_peaks_per_angle': (1, 5),
    'hough_proposal_limit': (10, 160),
    'section_bin_px': (1.0, 6.0),
    'core_half_width_px': (0.5, 2.5),
    'core_max_gap_bins': (1, 10),
    'min_core_pixels': (8, 64),
    'min_shaft_length_px': (12.0, 60.0),
    'min_support_fraction': (0.3, 1.0),
    'max_core_residual_px': (0.5, 3.0),
    'section_center_tolerance_px': (2.0, 12.0),
    'max_empty_section_bins': (0, 4),
    'min_section_bins': (4, 16),
    'max_section_residual_px': (0.5, 3.0),
    'candidate_normal_similarity': (0.995, 0.99999),
    'candidate_offset_tolerance_px': (0.25, 2.0),
    'max_candidates': (1, 12),
    'min_triangulation_condition': (0.005, 0.1),
    'max_impact_radius_mm': (170.0, 260.0),
    'max_shaft_slope': (0.5, 3.0),
    'max_reprojection_error_px': (0.5, 3.0),
    'line_offset_uncertainty_px': (0.75, 2.0),
    'refine_uncertainty_mm': (2.0, 8.0),
    'refine_short_support_px': (24.0, 80.0),
    'comparable_support_fraction': (0.5, 0.95),
    'refine_reprojection_penalty': (0.5, 4.0),
    'ambiguity_distance_mm': (1.0, 3.0),
    'shaft_envelope_length_mm': (90.0, 217.0),
    'flight_radius_mm': (10.0, 30.0),
    'min_envelope_radius_px': (2.0, 8.0),

})


@dataclass(frozen=True)
class DetectionParameters:
    difference_threshold_gray: int = 2
    blob_threshold_gray: int = 24
    max_changed_fraction: float = 0.08
    min_blob_pixels: int = 8
    max_shaft_width_px: float = 9.0
    hough_sample_target: int = 600
    hough_angle_step_deg: int = 2
    hough_rho_bin_px: float = 2.0
    hough_peaks_per_angle: int = 3
    hough_proposal_limit: int = 80
    section_bin_px: float = 3.0
    core_half_width_px: float = 1.25
    core_max_gap_bins: int = 7
    min_core_pixels: int = 24
    min_shaft_length_px: float = 24.0
    min_support_fraction: float = 0.6
    max_core_residual_px: float = 1.5
    section_center_tolerance_px: float = 8.0
    max_empty_section_bins: int = 2
    min_section_bins: int = 8
    max_section_residual_px: float = 1.25
    candidate_normal_similarity: float = 0.9998
    candidate_offset_tolerance_px: float = 0.75
    max_candidates: int = 10
    min_triangulation_condition: float = 0.015
    max_impact_radius_mm: float = 260.0
    max_shaft_slope: float = 3.0
    max_reprojection_error_px: float = 1.5
    line_offset_uncertainty_px: float = 0.75
    refine_uncertainty_mm: float = 4.0
    refine_short_support_px: float = 45.0
    comparable_support_fraction: float = 0.8
    refine_reprojection_penalty: float = 2.0
    ambiguity_distance_mm: float = 3.0
    # Renderer limits: point 45 + barrel 65 + shaft 60 + flight 55 - overlap 8.
    shaft_envelope_length_mm: float = 217.0
    flight_radius_mm: float = 30.0
    min_envelope_radius_px: float = 8.0


    def __post_init__(self):
        for field in fields(self):
            value = getattr(self, field.name)
            integer = field.type is int
            if (type(value) is not int if integer else type(value) not in (int, float)):
                raise ValueError(f'{field.name} must be a finite {"integer" if integer else "number"}')
            low, high = PARAMETER_BOUNDS[field.name]
            if not low <= value <= high or not math.isfinite(value):
                raise ValueError(f'{field.name} must be in {low}..{high}')

    @classmethod
    def from_dict(cls, values):
        """Load a partial JSON object; omitted fields retain backward-compatible defaults."""
        if type(values) is not dict:
            raise ValueError('detection parameters must be an object')
        unknown = set(values)-set(PARAMETER_BOUNDS)
        if unknown:
            raise ValueError('unknown detection parameter fields: ' + ', '.join(sorted(map(str, unknown))))
        return cls(**values)

    def to_dict(self):
        return asdict(self)


DEFAULT_PARAMETERS = DetectionParameters()
