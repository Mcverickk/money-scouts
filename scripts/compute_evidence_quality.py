#!/usr/bin/env python3
import json
from pathlib import Path

# Simple evidence quality scorer across five sources
# Sources: Polymarket, ESPN, Flashscore, LiveScore, Sofascore

SOURCE_WEIGHTS = {
    'Polymarket': 0.25,
    'ESPN': 0.25,
    'Flashscore': 0.25,
    'LiveScore': 0.15,
    'Sofascore': 0.10
}

CONTEXT = {
    'low_threshold': 0.5
}

REPORT = {
    'summary': '',
    'details': [],
    'overall_quality': 0.0,
    'flags': []
}

def load_input(path: Path):
    with path.open() as f:
        return json.load(f)


def normalize_score(s: str) -> int:
    # naive normalization: extract numeric score if present in 'a-b'
    try:
        a, b = s.split('-')
        return int(a) + int(b)
    except Exception:
        return 0


def main():
    data_path = Path('/Users/chirag/Personal/money-scouts/scripts/evidence_sample.json')
    if not data_path.exists():
        print('Evidence sample data not found. Run build that creates evidence_sample.json.')
        return
    data = load_input(data_path)
    games = data.get('games', [])

    # Collect per-game per-source confidence and detect contradictions
    per_game_results = []
    total_weight = sum(SOURCE_WEIGHTS.values())

    for g in games:
        game_id = g.get('game_id')
        name = g.get('name')
        events = g.get('events', {})
        sources = list(events.keys())
        # For each event, compute a simple aggregate confidence
        # We define a contradiction if any two sources disagree on the score string.
        scores = {}
        elapsed = {}
        for src, ev in events.items():
            scores[src] = ev.get('score')
            elapsed[src] = ev.get('elapsed')

        # detect contradictions: if two sources disagree on the score
        unique_scores = set([str(v) for v in scores.values() if v is not None])
        contradiction = len(unique_scores) > 1

        # compute per-source confidence with a penalty if contradiction
        source_confidences = {}
        for src, ev in events.items():
            base = ev.get('confidence', 0.5)
            # apply a small penalty if this source is Sofascore and there's a detected contradiction
            if contradiction:
                penalty = 0.15 if src != 'Sofascore' else 0.30
            else:
                penalty = 0.0
            conf = max(0.0, min(1.0, base - penalty))
            # low-confidence flag
            if conf < CONTEXT['low_threshold']:
                REPORT['flags'].append({
                    'game_id': game_id,
                    'game_name': name,
                    'source': src,
                    'reason': 'low-confidence or conflicting data'
                })
            source_confidences[src] = conf

        # Weighted average for overall game quality
        overall = 0.0
        for src, conf in source_confidences.items():
            w = SOURCE_WEIGHTS.get(src, 0)
            overall += conf * w
        overall /= total_weight

        per_game_results.append({
            'game_id': game_id,
            'name': name,
            'overall_quality': round(overall, 4),
            'sources': source_confidences,
            'contradiction': bool(contradiction),
            'raw_scores': scores
        })

    # Build final report
    REPORT['summary'] = 'Evidence-quality assessment across sources. Low-confidence flags generated where applicable.'
    REPORT['details'] = per_game_results
    # Compute an overall quality across games (mean)
    if per_game_results:
        REPORT['overall_quality'] = round(sum(r['overall_quality'] for r in per_game_results) / len(per_game_results), 4)
    else:
        REPORT['overall_quality'] = 0.0

    # Print concise JSON report
    print(json.dumps(REPORT, indent=2))

if __name__ == '__main__':
    main()
