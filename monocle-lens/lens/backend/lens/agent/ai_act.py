"""
EU AI Act risk tiering — a deterministic decision table, not a model.

The same inputs always give the same tier, rationale and article references, and every
result carries the hash of this table, so an auditor can reproduce it exactly. It is
conservative by design: where the Act allows a derogation that needs a documented human
assessment (Article 6(3)), the table reports it as a consideration and does not apply it.

A screening aid for a demonstration — not legal advice.
"""
import hashlib
import json

PROHIBITED = [
    {'id': 'art5_1_a', 'ref': 'Article 5', 'label': 'subliminal, manipulative or deceptive techniques that materially distort behaviour',
     'any': ['subliminal', 'manipulat', 'deceptive technique']},
    {'id': 'art5_1_b', 'ref': 'Article 5', 'label': 'exploiting vulnerabilities due to age, disability or a social or economic situation',
     'any': ['exploit vulnerab', 'exploits vulnerab', 'exploiting vulnerab']},
    {'id': 'art5_1_c', 'ref': 'Article 5', 'label': 'social scoring leading to detrimental or unfavourable treatment',
     'any': ['social scor']},
    {'id': 'art5_1_d', 'ref': 'Article 5', 'label': 'assessing the risk of a person committing a criminal offence based solely on profiling',
     'all': [['predict', 'risk of'], ['crime', 'criminal offence', 'offending']]},
    {'id': 'art5_1_e', 'ref': 'Article 5', 'label': 'untargeted scraping of facial images to build facial recognition databases',
     'all': [['scrap'], ['facial']]},
    {'id': 'art5_1_f', 'ref': 'Article 5', 'label': 'emotion recognition in the workplace or in education institutions',
     'all': [['emotion recognition', 'infer emotion', 'detect emotion'], ['workplace', 'employee', 'staff', 'school', 'student', 'education']]},
    {'id': 'art5_1_g', 'ref': 'Article 5', 'label': 'biometric categorisation inferring race, political opinions, trade union membership, religion, sex life or sexual orientation',
     'requires_biometrics': True, 'any': ['race', 'ethnic', 'political opinion', 'trade union', 'religio', 'sexual orientation', 'sex life']},
    {'id': 'art5_1_h', 'ref': 'Article 5', 'label': 'real-time remote biometric identification in publicly accessible spaces for law enforcement',
     'requires_biometrics': True, 'all': [['real-time', 'real time', 'live '], ['public'], ['police', 'law enforcement']]},
]

HIGH_RISK = [
    {'id': 'annex3_1', 'ref': 'Annex III', 'point': '1', 'hint': 'biometric',
     'label': 'biometrics — remote biometric identification, biometric categorisation or emotion recognition',
     'requires_biometrics': True, 'unless_any': ['verification', 'verify identity', 'confirm identity', 'authenticat', 'unlock']},
    {'id': 'annex3_2', 'ref': 'Annex III', 'point': '2', 'hint': 'critical infrastructure',
     'label': 'safety component in the management and operation of critical infrastructure',
     'sectors': ['critical_infrastructure']},
    {'id': 'annex3_3', 'ref': 'Annex III', 'point': '3', 'hint': 'vocational training',
     'label': 'education and vocational training — admission, evaluation of learning outcomes, monitoring of tests',
     'any': ['admission', 'exam', 'grading', 'proctor', 'learning outcome', 'assess student']},
    {'id': 'annex3_4', 'ref': 'Annex III', 'point': '4', 'hint': 'recruitment',
     'label': 'employment — recruitment, selection, promotion, termination, task allocation, monitoring or evaluation of workers',
     'any': ['recruit', 'hiring', 'candidate', 'curriculum vitae', 'job applica', 'promotion', 'terminat', 'dismiss', 'employee performance', 'task allocation']},
    {'id': 'annex3_5a', 'ref': 'Annex III', 'point': '5(a)', 'hint': 'public assistance',
     'label': 'eligibility for essential public assistance benefits and services',
     'any': ['public assistance', 'social security', 'welfare benefit', 'benefit eligibility']},
    {'id': 'annex3_5b', 'ref': 'Annex III', 'point': '5(b)', 'hint': 'creditworthiness',
     'label': 'evaluating the creditworthiness of natural persons or establishing their credit score',
     'any': ['credit', 'loan', 'lending', 'creditworth', 'affordab', 'mortgage', 'overdraft'], 'unless_any': ['fraud']},
    {'id': 'annex3_5c', 'ref': 'Annex III', 'point': '5(c)', 'hint': 'life and health insurance',
     'label': 'risk assessment and pricing in relation to natural persons for life and health insurance',
     'all': [['life insurance', 'health insurance', 'life cover', 'medical aid'], ['pric', 'risk assess', 'underwrit', 'premium']]},
    {'id': 'annex3_5d', 'ref': 'Annex III', 'point': '5(d)', 'hint': 'emergency',
     'label': 'evaluating and classifying emergency calls or dispatching emergency services',
     'any': ['emergency call', 'dispatch emergency', 'emergency triage']},
    {'id': 'annex3_6', 'ref': 'Annex III', 'point': '6', 'hint': 'law enforcement',
     'label': 'law enforcement uses', 'sectors': ['law_enforcement']},
    {'id': 'annex3_7', 'ref': 'Annex III', 'point': '7', 'hint': 'migration',
     'label': 'migration, asylum and border control management', 'any': ['migration', 'asylum', 'border control', 'visa applica']},
    {'id': 'annex3_8', 'ref': 'Annex III', 'point': '8', 'hint': 'administration of justice',
     'label': 'administration of justice and democratic processes', 'any': ['judicial', 'court decision', 'influence the outcome of an election', 'voting behaviour']},
]

TRANSPARENCY = [
    {'id': 'art50_1', 'ref': 'Article 50', 'label': 'system interacts directly with natural persons (e.g. chatbot)',
     'any': ['chatbot', 'chat bot', 'virtual assistant', 'conversational', 'interacts with customers', 'customer-facing assistant']},
    {'id': 'art50_2', 'ref': 'Article 50', 'label': 'system generates synthetic text, audio, image or video content',
     'any': ['generate', 'draft', 'llm', 'large language model', 'gpt', 'synthetic', 'generative']},
    {'id': 'art50_3', 'ref': 'Article 50', 'label': 'emotion recognition or biometric categorisation system',
     'any': ['emotion recognition', 'biometric categorisation', 'biometric categorization']},
    {'id': 'art50_4', 'ref': 'Article 50', 'label': 'deep fake content', 'any': ['deepfake', 'deep fake']},
]

OBLIGATIONS = {
    'prohibited': [
        ('Article 5', 'The practice is prohibited: it may not be placed on the market, put into service or used.'),
        ('Article 99', 'Breaches of the Article 5 prohibitions attract the highest tier of administrative fines.'),
    ],
    'high_risk': [
        ('Article 9', 'Provider: risk management system maintained across the lifecycle.'),
        ('Article 10', 'Provider: data governance and quality criteria for training, validation and testing data.'),
        ('Article 11', 'Provider: technical documentation drawn up before placing on the market.'),
        ('Article 12', 'Provider: automatic recording of events (logs) over the lifetime of the system.'),
        ('Article 13', 'Provider: transparency and instructions for use for deployers.'),
        ('Article 14', 'Provider: designed to allow effective human oversight.'),
        ('Article 15', 'Provider: appropriate accuracy, robustness and cybersecurity.'),
        ('Article 17', 'Provider: quality management system.'),
        ('Article 43', 'Provider: conformity assessment before placing on the market.'),
        ('Article 26', 'Deployer: use per instructions, assign human oversight, monitor operation, keep logs, inform affected persons.'),
        ('Article 27', 'Deployer: fundamental rights impact assessment — required for Annex III 5(b) credit and 5(c) insurance systems and for public bodies.'),
        ('Article 86', 'Affected persons: right to an explanation of individual decisions based on the output of a high-risk system.'),
    ],
    'limited': [
        ('Article 50', 'Transparency: people must be told they are interacting with an AI system, or that content is AI-generated.'),
    ],
    'minimal': [
        ('Article 95', 'No mandatory requirements specific to the system; voluntary codes of conduct are encouraged.'),
    ],
}
ALWAYS = [('Article 4', 'Providers and deployers: ensure a sufficient level of AI literacy among staff.')]

TABLE_VERSION = hashlib.sha256(
    json.dumps([PROHIBITED, HIGH_RISK, TRANSPARENCY, OBLIGATIONS, ALWAYS], sort_keys=True).encode()
).hexdigest()[:8]


def _matches(rule, text, sector, uses_biometrics):
    if rule.get('requires_biometrics') and not uses_biometrics:
        return False
    if 'any' in rule and not any(k in text for k in rule['any']):
        return False
    if 'all' in rule and not all(any(k in text for k in group) for group in rule['all']):
        return False
    if 'sectors' in rule and sector not in rule['sectors']:
        return False
    return True


def classify(system_description, sector, uses_biometrics, affects_credit_or_employment):
    text = f' {system_description.lower()} '
    decision_path, rationale, considerations, refs = [], [], [], []

    prohibited = [r for r in PROHIBITED if _matches(r, text, sector, uses_biometrics)]
    high = []
    for r in HIGH_RISK:
        if not _matches(r, text, sector, uses_biometrics):
            continue
        excluded = [k for k in r.get('unless_any', []) if k in text]
        if excluded:
            decision_path.append(f"{r['id']}: excluded ({', '.join(excluded)})")
            considerations.append(f"Annex III point {r['point']} may not apply: the description mentions {', '.join(excluded)}, "
                                  'which the Act carves out of this category. Confirm against the Annex text.')
            continue
        high.append(r)
    if affects_credit_or_employment and not any(r['id'] in ('annex3_4', 'annex3_5b') for r in high):
        decision_path.append('flag: affects_credit_or_employment=true')
        high.append({'id': 'annex3_4_5b_flag', 'ref': 'Annex III', 'point': '4 / 5(b)', 'hint': 'creditworthiness',
                     'label': 'declared to affect credit or employment decisions about natural persons'})
    transparency = [r for r in TRANSPARENCY if _matches(r, text, sector, uses_biometrics)]

    if prohibited:
        tier = 'prohibited'
        for r in prohibited:
            decision_path.append(r['id'])
            rationale.append(f"Article 5 prohibited practice: {r['label']}.")
    elif high:
        tier = 'high_risk'
        for r in high:
            decision_path.append(r['id'])
            rationale.append(f"Article 6(2) and Annex III point {r['point']}: {r['label']}.")
        refs.append('Article 6')
        considerations.append(
            'Article 6(3): an Annex III system is not high-risk if it does not pose a significant risk of harm — e.g. it '
            'performs a narrow procedural or preparatory task, or improves a completed human activity — unless it profiles '
            'natural persons. Relying on this requires a documented assessment; this table does not apply it.'
        )
    elif transparency:
        tier = 'limited'
        decision_path.extend(r['id'] for r in transparency)
        rationale.append('No prohibited practice or Annex III use case matched; transparency obligations apply.')
    else:
        tier = 'minimal'
        decision_path.append('no_rule_matched')
        rationale.append('No prohibited practice, Annex III use case or transparency trigger matched the description.')

    if transparency and tier != 'limited':
        considerations.append('Article 50 transparency duties may apply in addition: '
                              + '; '.join(r['label'] for r in transparency) + '.')
    if any(k in text for k in ('llm', 'large language model', 'gpt', 'foundation model', 'general-purpose')):
        considerations.append('The system builds on a general-purpose AI model: Chapter V obligations fall on the model '
                              'provider; the bank remains responsible as provider or deployer of the AI system itself.')

    obligations = [{'article': a, 'summary': s} for a, s in OBLIGATIONS[tier] + ALWAYS]
    for o in obligations:
        if o['article'] not in refs:
            refs.append(o['article'])
    if tier == 'high_risk':
        refs.append('Annex III')

    return {
        'deterministic': True,
        'table_version': TABLE_VERSION,
        'inputs': {'system_description': system_description, 'sector': sector, 'uses_biometrics': uses_biometrics,
                   'affects_credit_or_employment': affects_credit_or_employment},
        'tier': tier,
        'decision_path': decision_path,
        'rationale': rationale,
        'obligations': obligations,
        'considerations': considerations,
        'article_refs': refs,
        'annex_hints': [r['hint'] for r in high if r.get('hint')],
        'disclaimer': 'Deterministic screening aid for demonstration; not legal advice.',
    }
