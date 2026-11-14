const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSpecifications } = require('../.build/comparator.js');
const { renderMarkdown } = require('../.build/report.js');

const schemes = () => ({
  apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  partnerKey: { type: 'apiKey', in: 'header', name: 'X-Partner-Key' },
  basic: { type: 'http', scheme: 'basic' },
  bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  oauth: { type: 'oauth2', flows: { authorizationCode: {
    authorizationUrl: 'https://auth.example.test/authorize',
    tokenUrl: 'https://auth.example.test/token',
    scopes: { read: 'Read orders', write: 'Change orders', admin: 'Administer' },
  } } },
  oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://auth.example.test/.well-known/openid-configuration' },
});

/** Two operations: `GET /orders` and `POST /orders`, neither declaring security. */
const base = (version = '3.0.3') => ({
  openapi: version,
  components: { securitySchemes: schemes() },
  paths: {
    '/orders': {
      get: { responses: { '200': { description: 'ok' } } },
      post: { responses: { '201': { description: 'created' } } },
    },
  },
});

const getOp = spec => spec.paths['/orders'].get;
const postOp = spec => spec.paths['/orders'].post;

/** Compares two documents that differ only in the `GET /orders` security. */
function compareGet(oldSecurity, newSecurity, mutate) {
  const before = base(), after = base();
  if (oldSecurity !== undefined) getOp(before).security = oldSecurity;
  if (newSecurity !== undefined) getOp(after).security = newSecurity;
  if (mutate) mutate(before, after);
  return compareSpecifications(before, after);
}

const codesOf = findings => findings.map(f => `${f.code} @ ${f.location}`);

function assertBreaking(result, expected) {
  assert.deepEqual(codesOf(result.breaking), expected);
  assert.deepEqual(result.notices, [], 'an established verdict needs no review notice');
}

function assertCompatible(result) {
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, []);
}

function assertReviewOnly(result, expected) {
  assert.deepEqual(result.breaking, [], 'an inconclusive change is never reported as breaking');
  assert.deepEqual(codesOf(result.notices), expected);
}

// --- Introducing mandatory authentication ------------------------------------

test('adding a requirement to an unsecured operation is breaking', () => {
  const result = compareGet(undefined, [{ apiKey: [] }]);
  assertBreaking(result, ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
  assert.match(result.breaking[0].message, /accepted: apiKey/);
});

test('a document-level requirement added later reaches every inheriting operation', () => {
  const before = base(), after = base();
  after.security = [{ apiKey: [] }];
  assertBreaking(compareSpecifications(before, after), [
    'SECURITY_AUTHENTICATION_REQUIRED @ GET /orders',
    'SECURITY_AUTHENTICATION_REQUIRED @ POST /orders',
  ]);
});

test('dropping an explicit `security: []` exposes the operation to the document default', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  after.security = [{ apiKey: [] }];
  getOp(before).security = [];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
});

test('removing the empty requirement makes optional authentication mandatory', () => {
  const result = compareGet([{}, { apiKey: [] }], [{ apiKey: [] }]);
  assertBreaking(result, ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
});

test('an explicit empty list and an absent declaration are both unsecured', () => {
  assertBreaking(compareGet([], [{ oauth: ['read'] }]), ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
  assertBreaking(compareGet([{}], [{ oauth: ['read'] }]), ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
});

test('mandatory authentication through a scheme added in the same change is breaking', () => {
  const before = base(), after = base();
  delete before.components;
  getOp(after).security = [{ apiKey: [] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_AUTHENTICATION_REQUIRED @ GET /orders']);
});

// --- Added schemes (AND) ------------------------------------------------------

test('requiring a second scheme alongside the first is breaking', () => {
  const result = compareGet([{ apiKey: [] }], [{ apiKey: [], bearer: [] }]);
  assertBreaking(result, ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
  assert.match(result.breaking[0].message, /`bearer`/);
  assert.match(result.breaking[0].message, /apiKey → apiKey \+ bearer/);
});

test('a required scheme introduced in the same change is breaking', () => {
  const result = compareGet([{ apiKey: [] }], [{ apiKey: [], signature: [] }], (before, after) => {
    after.components.securitySchemes.signature = { type: 'http', scheme: 'hmac' };
  });
  assertBreaking(result, ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
});

test('an added scheme and tightened scopes are reported together', () => {
  const result = compareGet([{ oauth: ['read'] }], [{ oauth: ['read', 'write'], apiKey: [] }]);
  assertBreaking(result, ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
  assert.match(result.breaking[0].message, /`apiKey`/);
  assert.match(result.breaking[0].message, /scope `write` for `oauth`/);
});

// --- OAuth2 and OpenID Connect scopes ----------------------------------------

test('requiring an additional OAuth2 scope is breaking', () => {
  const result = compareGet([{ oauth: ['read'] }], [{ oauth: ['read', 'write'] }]);
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
  assert.match(result.breaking[0].message, /scope `write` for `oauth`/);
  assert.match(result.breaking[0].message, /oauth\(read\) → oauth\(read, write\)/);
});

test('requiring a first scope where none was needed is breaking', () => {
  assertBreaking(compareGet([{ oauth: [] }], [{ oauth: ['read'] }]), ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('swapping one required scope for another is breaking', () => {
  const result = compareGet([{ oauth: ['read'] }], [{ oauth: ['admin'] }]);
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('OpenID Connect scopes tighten the same way', () => {
  const result = compareGet([{ oidc: ['openid'] }], [{ oidc: ['openid', 'profile'] }]);
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('a tightened scope is breaking even when another scheme was dropped', () => {
  const result = compareGet([{ oauth: ['read'], apiKey: [] }], [{ oauth: ['read', 'write'] }]);
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('dropping a required scope is compatible', () => {
  assertCompatible(compareGet([{ oauth: ['read', 'write'] }], [{ oauth: ['read'] }]));
  assertCompatible(compareGet([{ oidc: ['openid', 'profile'] }], [{ oidc: ['openid'] }]));
});

test('scope order and repeated scopes carry no meaning', () => {
  assertCompatible(compareGet([{ oauth: ['read', 'write'] }], [{ oauth: ['write', 'read', 'read'] }]));
});

// --- Removed alternatives (OR) -------------------------------------------------

test('removing one of several alternatives is breaking', () => {
  const result = compareGet([{ apiKey: [] }, { oauth: ['read'] }], [{ oauth: ['read'] }]);
  assertBreaking(result, ['SECURITY_ALTERNATIVE_REMOVED @ GET /orders']);
  assert.match(result.breaking[0].message, /alternative apiKey is no longer accepted/);
  assert.match(result.breaking[0].message, /oauth\(read\)/);
});

test('replacing a scheme with a different existing scheme is breaking', () => {
  const result = compareGet([{ apiKey: [] }], [{ partnerKey: [] }]);
  assertBreaking(result, ['SECURITY_ALTERNATIVE_REMOVED @ GET /orders']);
});

test('replacing a scheme with a new one of a different kind is breaking', () => {
  const before = base(), after = base();
  delete before.components.securitySchemes.oauth;
  getOp(before).security = [{ apiKey: [] }];
  getOp(after).security = [{ oauth: ['read'] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_ALTERNATIVE_REMOVED @ GET /orders']);
});

test('swapping the partner scheme inside a combined requirement is breaking', () => {
  const result = compareGet([{ apiKey: [], basic: [] }], [{ apiKey: [], bearer: [] }]);
  assertBreaking(result, ['SECURITY_ALTERNATIVE_REMOVED @ GET /orders']);
});

test('only the alternative that lost its match is reported', () => {
  const result = compareGet(
    [{ apiKey: [] }, { oauth: ['read'] }],
    [{ apiKey: [] }, { oauth: ['read', 'write'] }],
  );
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('each alternative that no longer suffices is reported on its own', () => {
  const result = compareGet([{}, { apiKey: [] }], [{ oauth: ['read'] }]);
  assertBreaking(result, [
    'SECURITY_ALTERNATIVE_REMOVED @ GET /orders',
    'SECURITY_AUTHENTICATION_REQUIRED @ GET /orders',
  ]);
});

test('the closest remaining alternative explains the break', () => {
  const result = compareGet(
    [{ oauth: ['read'] }],
    [{ partnerKey: [] }, { oauth: ['read'], apiKey: [] }, { oauth: ['read', 'write', 'admin'] }],
  );
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
  assert.match(result.breaking[0].message, /scopes `admin`, `write` for `oauth`/);
});

// --- Relaxations ---------------------------------------------------------------

test('removing security altogether is compatible', () => {
  assertCompatible(compareGet([{ apiKey: [] }], undefined));
  assertCompatible(compareGet([{ apiKey: [] }], []));
});

test('an operation opting out of the document default is compatible', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read'] }];
  after.security = [{ oauth: ['read'] }];
  getOp(after).security = [];
  assertCompatible(compareSpecifications(before, after));
});

test('making authentication optional is compatible', () => {
  assertCompatible(compareGet([{ apiKey: [] }], [{ apiKey: [] }, {}]));
});

test('adding an alternative is compatible', () => {
  assertCompatible(compareGet([{ apiKey: [] }], [{ apiKey: [] }, { oauth: ['read'] }]));
});

test('adding an alternative that uses a brand-new scheme is compatible', () => {
  const result = compareGet([{ apiKey: [] }], [{ apiKey: [] }, { session: [] }], (before, after) => {
    after.components.securitySchemes.session = { type: 'apiKey', in: 'cookie', name: 'sid' };
  });
  assertCompatible(result);
});

test('no longer requiring one scheme of a combination is compatible', () => {
  assertCompatible(compareGet([{ apiKey: [], bearer: [] }], [{ apiKey: [] }]));
});

test('an alternative that a weaker remaining one already covers may be removed', () => {
  assertCompatible(compareGet([{ oauth: ['read'] }, { oauth: ['read', 'write'] }], [{ oauth: ['read'] }]));
  assertCompatible(compareGet([{ apiKey: [] }, { apiKey: [], bearer: [] }], [{ apiKey: [] }]));
});

test('removing an authenticated alternative is compatible while anonymous access remains', () => {
  assertCompatible(compareGet([{}, { apiKey: [] }], [{}]));
  assertCompatible(compareGet([{}, { apiKey: [] }], []));
});

// --- Equivalent spellings --------------------------------------------------------

test('reordering alternatives is not a change', () => {
  assertCompatible(compareGet(
    [{ apiKey: [] }, { oauth: ['read'] }, { basic: [], bearer: [] }],
    [{ bearer: [], basic: [] }, { oauth: ['read'] }, { apiKey: [] }],
  ));
});

test('a repeated alternative is not a change', () => {
  assertCompatible(compareGet([{ apiKey: [] }], [{ apiKey: [] }, { apiKey: [] }]));
});

test('`security: []`, `[{}]` and no declaration all mean unsecured', () => {
  assertCompatible(compareGet(undefined, []));
  assertCompatible(compareGet([], [{}]));
  assertCompatible(compareGet([{}], undefined));
});

test('moving a requirement between the document and the operation is not a change', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  getOp(after).security = [{ apiKey: [] }];
  postOp(after).security = [{ apiKey: [] }];
  assertCompatible(compareSpecifications(before, after));
  assertCompatible(compareSpecifications(after, before));
});

// --- Inheritance and overrides ----------------------------------------------------

test('a tightened document default spares operations that override it', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read'] }];
  after.security = [{ oauth: ['read', 'write'] }];
  postOp(before).security = [{ apiKey: [] }];
  postOp(after).security = [{ apiKey: [] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('a changed document default does not reach an operation that stays unsecured', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  after.security = [{ apiKey: [], bearer: [] }];
  getOp(before).security = [];
  getOp(after).security = [];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_SCHEME_REQUIRED @ POST /orders']);
});

test('an override that is stricter than the inherited default is breaking', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read'] }];
  after.security = [{ oauth: ['read'] }];
  postOp(after).security = [{ oauth: ['read', 'admin'] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_SCOPE_REQUIRED @ POST /orders']);
});

test('an override that is looser than the inherited default is compatible', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read', 'write'] }];
  after.security = [{ oauth: ['read', 'write'] }];
  postOp(after).security = [{ oauth: ['read'] }, { apiKey: [] }];
  assertCompatible(compareSpecifications(before, after));
});

test('removing an override falls back to the document default', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read', 'write'] }];
  after.security = [{ oauth: ['read', 'write'] }];
  getOp(before).security = [{ oauth: ['read'] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('operations reached through a $ref are compared with their own override', () => {
  const before = base(), after = base();
  for (const spec of [before, after]) {
    spec.components.pathItems = { Orders: spec.paths['/orders'] };
    spec.paths['/orders'] = { $ref: '#/components/pathItems/Orders' };
    spec.security = [{ apiKey: [] }];
  }
  after.components.pathItems.Orders.get.security = [{ apiKey: [], basic: [] }];
  assertBreaking(compareSpecifications(before, after), ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
});

// --- Inconclusive changes stay review-required -------------------------------------

test('a scheme renamed with the same definition is not assumed to be the same credential', () => {
  const result = compareGet([{ apiKey: [] }], [{ gatewayKey: [] }], (before, after) => {
    after.components.securitySchemes.gatewayKey = { ...schemes().apiKey };
    delete after.components.securitySchemes.apiKey;
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`gatewayKey` is defined exactly like `apiKey`/);
});

test('a renamed scheme whose definition also moved is not decided either way', () => {
  const result = compareGet([{ apiKey: [] }], [{ gatewayKey: [] }], (before, after) => {
    after.components.securitySchemes.gatewayKey = { type: 'apiKey', in: 'header', name: 'X-Gateway-Key' };
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`gatewayKey` is new or redefined and may be the credential previously named `apiKey`/);
});

test('two existing schemes that look identical on the wire are not assumed to differ', () => {
  const mutate = (before, after) => {
    for (const spec of [before, after]) {
      spec.components.securitySchemes.serviceToken = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Service account' };
    }
  };
  assertReviewOnly(compareGet([{ bearer: [] }], [{ serviceToken: [] }], mutate), ['SECURITY_NOT_COMPARED @ GET /orders']);
  const combined = compareGet([{ bearer: [] }], [{ bearer: [], serviceToken: [] }], mutate);
  assertReviewOnly(combined, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(combined.notices[0].message, /`serviceToken` is defined exactly like `bearer`/);
});

test('a new scheme of the same kind is not assumed to be a different credential', () => {
  const result = compareGet([{ basic: [] }], [{ login: [] }], (before, after) => {
    after.components.securitySchemes.login = { type: 'http', scheme: 'Basic' };
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
});

test('requirements naming undefined schemes are not decided', () => {
  const result = compareGet([{ apiKey: [] }], [{ ghost: [] }]);
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`ghost` is not defined under `components\.securitySchemes` in the head document/);
});

test('a removed alternative whose scheme was never defined is not decided', () => {
  const result = compareGet([{ ghost: [] }], [{ apiKey: [] }]);
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`ghost` is not defined under `components\.securitySchemes` in the base document/);
});

test('undefined schemes do not hide a relaxation that needs no scheme knowledge', () => {
  assertCompatible(compareGet([{ ghost: [] }], [{ ghost: [] }, { apiKey: [] }]));
  assertCompatible(compareGet([{ ghost: [], phantom: [] }], [{ ghost: [] }]));
  assertCompatible(compareGet([{ ghost: [] }], []));
});

test('a relaxation over a redefined scheme is not taken as compatible', () => {
  const result = compareGet([{ apiKey: [], bearer: [] }], [{ apiKey: [] }], (before, after) => {
    after.components.securitySchemes.apiKey.name = 'X-Key';
  });
  assertReviewOnly(result, [
    'SECURITY_NOT_COMPARED @ components.securitySchemes.apiKey',
    'SECURITY_NOT_COMPARED @ GET /orders',
  ]);
  assert.match(result.notices[0].message, /still required by 1 operation,/);
  assert.match(result.notices[1].message, /`apiKey` may no longer be the same credential: its definition changed \(`name`\)/);
});

test('an established break does not hide a redefined scheme', () => {
  const result = compareGet([{ apiKey: [] }], [{ apiKey: [], bearer: [] }], (before, after) => {
    after.components.securitySchemes.apiKey.name = 'X-Key';
  });
  assert.deepEqual(codesOf(result.breaking), ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
  assert.deepEqual(codesOf(result.notices), ['SECURITY_NOT_COMPARED @ components.securitySchemes.apiKey']);
});

test('a scope change over a redefined OAuth2 scheme is not decided', () => {
  const result = compareGet([{ oauth: ['read'] }], [{ oauth: ['read', 'write'] }], (before, after) => {
    after.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl = 'https://login.example.test/token';
  });
  assertReviewOnly(result, [
    'SECURITY_NOT_COMPARED @ components.securitySchemes.oauth',
    'SECURITY_NOT_COMPARED @ GET /orders',
  ]);
});

test('a redefined scheme behind unchanged requirements is reported once, not per operation', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  after.security = [{ apiKey: [] }];
  after.components.securitySchemes.apiKey.in = 'query';
  const result = compareSpecifications(before, after);
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ components.securitySchemes.apiKey']);
  assert.match(result.notices[0].message, /still required by 2 operations,/);
  assert.match(result.notices[0].message, /its definition changed \(`in`\)/);
});

test('a scheme that changes type behind unchanged requirements is reported', () => {
  const before = base(), after = base();
  getOp(before).security = [{ basic: [] }];
  getOp(after).security = [{ basic: [] }];
  after.components.securitySchemes.basic = { type: 'apiKey', in: 'header', name: 'Authorization' };
  const result = compareSpecifications(before, after);
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ components.securitySchemes.basic']);
  assert.match(result.notices[0].message, /its type changed \(http → apiKey\)/);
});

test('a redefined scheme no operation relies on is left alone', () => {
  const before = base(), after = base();
  after.components.securitySchemes.partnerKey.name = 'X-Other';
  assertCompatible(compareSpecifications(before, after));
});

test('removing an OAuth2 flow or an offered scope is reported for review', () => {
  for (const mutate of [
    spec => { delete spec.components.securitySchemes.oauth.flows.authorizationCode.scopes.read; },
    spec => { spec.components.securitySchemes.oauth.flows = { clientCredentials: { tokenUrl: 'https://auth.example.test/token', scopes: {} } }; },
    spec => { spec.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl = 'https://login.example.test/token'; },
  ]) {
    const before = base(), after = base();
    before.security = [{ oauth: ['read'] }];
    after.security = [{ oauth: ['read'] }];
    mutate(after);
    assertReviewOnly(compareSpecifications(before, after), ['SECURITY_NOT_COMPARED @ components.securitySchemes.oauth']);
  }
});

test('scheme changes that take nothing away from a client are not reported', () => {
  const before = base(), after = base();
  before.security = [{ oauth: ['read'] }, { bearer: [] }];
  after.security = [{ oauth: ['read'] }, { bearer: [] }];
  const oauth = after.components.securitySchemes.oauth;
  oauth.description = 'Sign in with the identity provider.';
  oauth.flows.authorizationCode.scopes.read = 'Read orders and invoices';
  oauth.flows.authorizationCode.scopes.export = 'Export orders';
  oauth.flows.clientCredentials = { tokenUrl: 'https://auth.example.test/token', scopes: { read: 'Read orders' } };
  after.components.securitySchemes.bearer.scheme = 'Bearer';
  assertCompatible(compareSpecifications(before, after));
});

test('a scope tightened alongside harmless scheme edits is still breaking', () => {
  const result = compareGet([{ oauth: ['read'] }], [{ oauth: ['read', 'export'] }], (before, after) => {
    after.components.securitySchemes.oauth.flows.authorizationCode.scopes.export = 'Export orders';
  });
  assertBreaking(result, ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
});

test('a role list on a scheme without scopes is not read as a scope requirement', () => {
  const before = base('3.1.0'), after = base('3.1.0');
  getOp(before).security = [{ apiKey: [] }];
  getOp(after).security = [{ apiKey: ['admin'] }];
  const tightened = compareSpecifications(before, after);
  assertReviewOnly(tightened, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(tightened.notices[0].message, /not an OAuth2 or OpenID Connect scheme/);
  assertReviewOnly(compareSpecifications(after, before), ['SECURITY_NOT_COMPARED @ GET /orders']);
  assertCompatible(compareSpecifications(after, structuredClone(after)));
});

test('a scheme of an unsupported type is not interpreted', () => {
  const result = compareGet([{ legacy: [] }], [{ legacy: ['read'] }], (before, after) => {
    before.components.securitySchemes.legacy = { type: 'basic' };
    after.components.securitySchemes.legacy = { type: 'basic' };
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /unsupported type `basic`/);
});

test('replacing a scheme of an unsupported type is not decided', () => {
  const result = compareGet([{ legacy: [] }], [{ basic: [] }], (before, after) => {
    before.components.securitySchemes.legacy = { type: 'basic' };
    after.components.securitySchemes.legacy = { type: 'basic' };
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
});

test('a scheme definition that cannot be resolved is reported, not thrown', () => {
  const result = compareGet([{ apiKey: [] }], [{ apiKey: [], remote: [] }], (before, after) => {
    after.components.securitySchemes.remote = { $ref: 'https://example.test/schemes.yaml#/remote' };
  });
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`remote` cannot be read in the head document/);
});

test('a scheme definition behind an internal $ref is resolved', () => {
  const result = compareGet([{ alias: [] }], [{ alias: [], basic: [] }], (before, after) => {
    for (const spec of [before, after]) {
      spec.components.securitySchemes.alias = { $ref: '#/components/securitySchemes/apiKey' };
    }
  });
  assertBreaking(result, ['SECURITY_SCHEME_REQUIRED @ GET /orders']);
});

test('a malformed security declaration is reported instead of being skipped', () => {
  for (const malformed of [{ apiKey: [] }, 'apiKey', [['apiKey']], [{ apiKey: 'read' }], [{ oauth: [1] }], null]) {
    const result = compareGet([{ apiKey: [] }], malformed);
    assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
    assert.match(result.notices[0].message, /could not be read: .* in the head document/);
  }
  assertReviewOnly(compareGet('apiKey', [{ apiKey: [] }]), ['SECURITY_NOT_COMPARED @ GET /orders']);
});

test('an unchanged malformed declaration stays quiet', () => {
  assertCompatible(compareGet([{ apiKey: 'read' }], [{ apiKey: 'read' }]));
  assertCompatible(compareGet({ apiKey: [], basic: [] }, { basic: [], apiKey: [] }));
});

test('a malformed document default only affects operations that inherit it', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  after.security = 'apiKey';
  postOp(before).security = [{ basic: [] }];
  postOp(after).security = [{ basic: [] }];
  assertReviewOnly(compareSpecifications(before, after), ['SECURITY_NOT_COMPARED @ GET /orders']);
});

test('an established break and an inconclusive alternative are reported side by side', () => {
  const result = compareGet([{ oauth: ['read'] }, { apiKey: [] }], [{ oauth: ['read', 'write'] }, { gatewayKey: [] }],
    (before, after) => {
      after.components.securitySchemes.gatewayKey = { type: 'apiKey', in: 'header', name: 'X-Gateway-Key' };
    });
  assert.deepEqual(codesOf(result.breaking), ['SECURITY_SCOPE_REQUIRED @ GET /orders']);
  assert.deepEqual(codesOf(result.notices), ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /accepted for apiKey still suffice/);
});

test('scheme names that collide with object built-ins are ordinary names', () => {
  const result = compareGet([{ constructor: [] }], [{ constructor: [], toString: [] }]);
  assertReviewOnly(result, ['SECURITY_NOT_COMPARED @ GET /orders']);
  assert.match(result.notices[0].message, /`toString` is not defined/);
});

// --- Determinism and reporting ----------------------------------------------------

test('the result does not depend on how the documents are spelled', () => {
  const build = reversed => {
    const before = base(), after = base();
    const oldAlternatives = [{ apiKey: [] }, { oauth: ['read'] }, { basic: [], bearer: [] }];
    const newAlternatives = [{ oauth: ['write', 'read'] }, { bearer: [], basic: [], partnerKey: [] }, { oidc: ['openid'] }];
    getOp(before).security = reversed ? oldAlternatives.reverse() : oldAlternatives;
    getOp(after).security = reversed ? newAlternatives.reverse() : newAlternatives;
    if (reversed) {
      after.components.securitySchemes = Object.fromEntries(Object.entries(after.components.securitySchemes).reverse());
    }
    return compareSpecifications(before, after);
  };
  const first = build(false);
  assert.deepEqual(codesOf(first.breaking), [
    'SECURITY_ALTERNATIVE_REMOVED @ GET /orders',
    'SECURITY_SCHEME_REQUIRED @ GET /orders',
    'SECURITY_SCOPE_REQUIRED @ GET /orders',
  ]);
  assert.deepEqual(build(true), first);
  assert.deepEqual(build(false), first);
});

test('a security change does not disturb the other rules for the operation', () => {
  const before = base(), after = base();
  getOp(before).parameters = [{ name: 'page', in: 'query', schema: { type: 'integer' } }];
  getOp(after).parameters = [];
  getOp(after).security = [{ apiKey: [] }];
  assert.deepEqual(codesOf(compareSpecifications(before, after).breaking), [
    'SECURITY_AUTHENTICATION_REQUIRED @ GET /orders',
    'PARAMETER_REMOVED @ GET /orders query:page',
  ]);
});

test('a removed operation is not also reported for its security', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  delete after.paths['/orders'].get;
  after.security = [{ apiKey: [], bearer: [] }];
  assert.deepEqual(codesOf(compareSpecifications(before, after).breaking), [
    'OPERATION_REMOVED @ GET /orders',
    'SECURITY_SCHEME_REQUIRED @ POST /orders',
  ]);
});

test('security findings appear in the Markdown report', () => {
  const breaking = renderMarkdown(compareGet([{ oauth: ['read'] }, { apiKey: [] }], [{ oauth: ['read', 'write'] }]));
  assert.match(breaking, /Found \*\*2\*\* potentially breaking changes/);
  assert.match(breaking, /\| `SECURITY_SCOPE_REQUIRED` \| `GET \/orders` \| Now requires scope `write` for `oauth`/);
  assert.match(breaking, /\| `SECURITY_ALTERNATIVE_REMOVED` \| `GET \/orders` \|/);

  const review = renderMarkdown(compareGet([{ apiKey: [] }], [{ ghost: [] }]));
  assert.match(review, /No breaking changes detected/);
  assert.match(review, /\| `SECURITY_NOT_COMPARED` \| `GET \/orders` \|/);
  for (const line of review.split('\n').filter(l => l.startsWith('| `'))) {
    assert.equal(line.replace(/\\\|/g, '').split('|').length, 5, 'table cells stay intact');
  }
});
