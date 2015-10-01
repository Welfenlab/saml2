var IdentityProvider, SAMLError, ServiceProvider, XMLNS, _, async, certificate_to_keyinfo, check_saml_signature, check_status_success, create_authn_request, create_logout_request, create_logout_response, create_metadata, crypto, debug, decrypt_assertion, format_pem, get_name_id, get_session_index, get_status, parseString, parse_assertion_attributes, parse_authn_response, parse_logout_request, parse_response_header, pretty_assertion_attributes, set_option_defaults, sign_request, to_error, url, util, xmlbuilder, xmlcrypto, xmldom, xmlenc, zlib,
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty,
  slice = [].slice,
  bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

_ = require('underscore');

async = _.extend(require('async'), require('async-ext'));

crypto = require('crypto');

debug = require('debug')('saml2');

parseString = require('xml2js').parseString;

url = require('url');

util = require('util');

xmlbuilder = require('xmlbuilder');

xmlcrypto = require('xml-crypto');

xmldom = require('xmldom');

xmlenc = require('xml-encryption');

zlib = require('zlib');

XMLNS = {
  SAML: 'urn:oasis:names:tc:SAML:2.0:assertion',
  SAMLP: 'urn:oasis:names:tc:SAML:2.0:protocol',
  MD: 'urn:oasis:names:tc:SAML:2.0:metadata',
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XENC: 'http://www.w3.org/2001/04/xmlenc#'
};

SAMLError = (function(superClass) {
  extend(SAMLError, superClass);

  function SAMLError(message, extra) {
    this.message = message;
    this.extra = extra;
    SAMLError.__super__.constructor.call(this, this.message);
  }

  return SAMLError;

})(Error);

create_authn_request = function(issuer, assert_endpoint, destination, force_authn, context, nameid_format) {
  var context_element, id, xml;
  if (context != null) {
    context_element = _(context.class_refs).map(function(class_ref) {
      return {
        'saml:AuthnContextClassRef': class_ref
      };
    });
    context_element.push({
      '@Comparison': context.comparison
    });
  }
  id = '_' + crypto.randomBytes(21).toString('hex');
  xml = xmlbuilder.create({
    AuthnRequest: {
      '@xmlns': XMLNS.SAMLP,
      '@xmlns:saml': XMLNS.SAML,
      '@Version': '2.0',
      '@ID': id,
      '@IssueInstant': (new Date()).toISOString(),
      '@Destination': destination,
      '@AssertionConsumerServiceURL': assert_endpoint,
      '@ProtocolBinding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      '@ForceAuthn': force_authn,
      'saml:Issuer': issuer,
//      NameIDPolicy: {
//        '@Format': nameid_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
//        '@AllowCreate': 'true'
//      },
      RequestedAuthnContext: context_element
    }
  }).end();
  return {
    id: id,
    xml: xml
  };
};

create_metadata = function(entity_id, assert_endpoint, signing_certificate, encryption_certificate) {
  return xmlbuilder.create({
    'md:EntityDescriptor': {
      '@xmlns:md': XMLNS.MD,
      '@xmlns:ds': XMLNS.DS,
      '@entityID': entity_id,
      'md:SPSSODescriptor': [
        {
          '@protocolSupportEnumeration': 'urn:oasis:names:tc:SAML:1.1:protocol urn:oasis:names:tc:SAML:2.0:protocol'
        }, {
          'md:KeyDescriptor': certificate_to_keyinfo('signing', signing_certificate)
        }, {
          'md:KeyDescriptor': certificate_to_keyinfo('encryption', encryption_certificate)
        }, {
          'md:AssertionConsumerService': {
            '@Binding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
            '@Location': assert_endpoint,
            '@index': '0'
          },
          'md:SingleLogoutService': {
            '@Binding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
            '@Location': assert_endpoint
          }
        }
      ]
    }
  }).end();
};

create_logout_request = function(issuer, name_id, session_index, destination) {
  return xmlbuilder.create({
    'samlp:LogoutRequest': {
      '@xmlns:samlp': XMLNS.SAMLP,
      '@xmlns:saml': XMLNS.SAML,
      '@ID': '_' + crypto.randomBytes(21).toString('hex'),
      '@Version': '2.0',
      '@IssueInstant': (new Date()).toISOString(),
      '@Destination': destination,
      'saml:Issuer': issuer,
      'saml:NameID': name_id,
      'samlp:SessionIndex': session_index
    }
  }).end();
};

create_logout_response = function(issuer, in_response_to, destination, status) {
  if (status == null) {
    status = 'urn:oasis:names:tc:SAML:2.0:status:Success';
  }
  return xmlbuilder.create({
    'samlp:LogoutResponse': {
      '@Destination': destination,
      '@ID': '_' + crypto.randomBytes(21).toString('hex'),
      '@InResponseTo': in_response_to,
      '@IssueInstant': (new Date()).toISOString(),
      '@Version': '2.0',
      '@xmlns:samlp': XMLNS.SAMLP,
      '@xmlns:saml': XMLNS.SAML,
      'saml:Issuer': issuer,
      'samlp:Status': {
        'samlp:StatusCode': {
          '@Value': status
        }
      }
    }
  }, {
    headless: true
  }).end();
};

format_pem = function(key, type) {
  if ((/-----BEGIN [0-9A-Z ]+-----[^-]*-----END [0-9A-Z ]+-----/g.exec(key)) != null) {
    return key;
  }
  return ("-----BEGIN " + (type.toUpperCase()) + "-----\n") + key.match(/.{1,64}/g).join("\n") + ("\n-----END " + (type.toUpperCase()) + "-----");
};

sign_request = function(saml_request, private_key, relay_state, response) {
  var action, data, relay_state_data, samlQueryString, saml_request_data, sigalg_data, sign;
  if (response == null) {
    response = false;
  }
  action = response ? "SAMLResponse" : "SAMLRequest";
  data = (action + "=") + encodeURIComponent(saml_request);
  if (relay_state) {
    data += "&RelayState=" + encodeURIComponent(relay_state);
  }
  data += "&SigAlg=" + encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
  saml_request_data = (action + "=") + encodeURIComponent(saml_request);
  relay_state_data = relay_state != null ? "&RelayState=" + encodeURIComponent(relay_state) : "";
  sigalg_data = "&SigAlg=" + encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
  sign = crypto.createSign('RSA-SHA256');
  sign.update(saml_request_data + relay_state_data + sigalg_data);
  samlQueryString = {};
  if (response) {
    samlQueryString.SAMLResponse = saml_request;
  } else {
    samlQueryString.SAMLRequest = saml_request;
  }
  if (relay_state) {
    samlQueryString.RelayState = relay_state;
  }
  samlQueryString.SigAlg = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  samlQueryString.Signature = sign.sign(format_pem(private_key, 'PRIVATE KEY'), 'base64');
  return samlQueryString;
};

certificate_to_keyinfo = function(use, certificate) {
  var cert_data;
  cert_data = /-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/g.exec(certificate);
  cert_data = cert_data != null ? cert_data[1] : certificate;
  if (cert_data == null) {
    throw new Error('Invalid Certificate');
  }
  return {
    '@use': use,
    'ds:KeyInfo': {
      '@xmlns:ds': XMLNS.DS,
      'ds:X509Data': {
        'ds:X509Certificate': cert_data.replace(/[\r\n|\n]/g, '')
      }
    }
  };
};

check_saml_signature = function(xml,xmlAll, certificate, cb) {
  var doc, sig, signature;
  doc = xmlAll;//(new xmldom.DOMParser()).parseFromString(xmlAll);
  signature = xmlcrypto.xpath(doc, "/*/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']");
  if (signature.length !== 1) {
    return false;
  }
  sig = new xmlcrypto.SignedXml();
  sig.keyInfoProvider = {
    getKey: function() {
      return format_pem(certificate, 'CERTIFICATE');
    }
  };
  sig.loadSignature(signature[0].toString());
  return sig.checkSignature(xmlAll.toString());
};

check_status_success = function(dom) {
  var attr, i, j, len, len1, ref, ref1, status, status_code;
  status = dom.getElementsByTagNameNS(XMLNS.SAMLP, 'Status');
  if (status.length !== 1) {
    return false;
  }
  ref = status[0].childNodes;
  for (i = 0, len = ref.length; i < len; i++) {
    status_code = ref[i];
    if (status_code.attributes != null) {
      ref1 = status_code.attributes;
      for (j = 0, len1 = ref1.length; j < len1; j++) {
        attr = ref1[j];
        if (attr.name === 'Value' && attr.value === 'urn:oasis:names:tc:SAML:2.0:status:Success') {
          return true;
        }
      }
    }
  }
  return false;
};

get_status = function(dom) {
  var attr, i, j, l, len, len1, len2, len3, m, ref, ref1, ref2, ref3, status, status_code, status_list, sub_status_code, top_status;
  status_list = {};
  status = dom.getElementsByTagNameNS(XMLNS.SAMLP, 'Status');
  if (status.length !== 1) {
    return status_list;
  }
  ref = status[0].childNodes;
  for (i = 0, len = ref.length; i < len; i++) {
    status_code = ref[i];
    if (status_code.attributes != null) {
      ref1 = status_code.attributes;
      for (j = 0, len1 = ref1.length; j < len1; j++) {
        attr = ref1[j];
        if (attr.name === 'Value') {
          top_status = attr.value;
          if (status_list[top_status] == null) {
            status_list[top_status] = [];
          }
        }
      }
    }
    ref2 = status_code.childNodes;
    for (l = 0, len2 = ref2.length; l < len2; l++) {
      sub_status_code = ref2[l];
      if (sub_status_code.attributes != null) {
        ref3 = sub_status_code.attributes;
        for (m = 0, len3 = ref3.length; m < len3; m++) {
          attr = ref3[m];
          if (attr.name === 'Value') {
            status_list[top_status].push(attr.value);
          }
        }
      }
    }
  }
  return status_list;
};

to_error = function(err) {
  if (err == null) {
    return null;
  }
  if (!(err instanceof Error)) {
    return new Error(util.inspect(err));
  }
  return err;
};

decrypt_assertion = function(dom, private_key, cb) {
  var encrypted_assertion, encrypted_data, err, error;
  cb = _.wrap(cb, function() {
    var args, err, fn;
    fn = arguments[0], err = arguments[1], args = 3 <= arguments.length ? slice.call(arguments, 2) : [];
    return setTimeout((function() {
      return fn.apply(null, [to_error(err)].concat(slice.call(args)));
    }), 0);
  });
  try {
    encrypted_assertion = dom.getElementsByTagNameNS(XMLNS.SAML, 'EncryptedAssertion');
    if (encrypted_assertion.length !== 1) {
      return cb(new Error("Expected 1 EncryptedAssertion; found " + encrypted_assertion.length + "."));
    }
    encrypted_data = encrypted_assertion[0].getElementsByTagNameNS(XMLNS.XENC, 'EncryptedData');
    if (encrypted_data.length !== 1) {
      return cb(new Error("Expected 1 EncryptedData inside EncryptedAssertion; found " + encrypted_data.length + "."));
    }
    return xmlenc.decrypt(encrypted_data[0].toString(), {
      key: format_pem(private_key, 'PRIVATE KEY')
    }, cb);
  } catch (error) {
    err = error;
    return cb(new Error("Decrypt failed: " + (util.inspect(err))));
  }
};

parse_response_header = function(dom) {
  var attr, i, j, len, len1, ref, ref1, response, response_header, response_type;
  ref = ['Response', 'LogoutResponse', 'LogoutRequest'];
  for (i = 0, len = ref.length; i < len; i++) {
    response_type = ref[i];
    response = dom.getElementsByTagNameNS(XMLNS.SAMLP, response_type);
    if (response.length > 0) {
      break;
    }
  }
  if (response.length !== 1) {
    throw new Error("Expected 1 Response; found " + response.length);
  }
  response_header = {};
  ref1 = response[0].attributes;
  for (j = 0, len1 = ref1.length; j < len1; j++) {
    attr = ref1[j];
    switch (attr.name) {
      case "Version":
        if (attr.value !== "2.0") {
          throw new Error("Invalid SAML Version " + attr.value);
        }
        break;
      case "Destination":
        response_header.destination = attr.value;
        break;
      case "InResponseTo":
        response_header.in_response_to = attr.value;
        break;
      case "ID":
        response_header.id = attr.value;
    }
  }
  return response_header;
};

get_name_id = function(dom) {
  var assertion, nameid, ref, subject;
  assertion = dom.getElementsByTagNameNS(XMLNS.SAML, 'Assertion');
  if (assertion.length !== 1) {
    throw new Error("Expected 1 Assertion; found " + assertion.length);
  }
  subject = assertion[0].getElementsByTagNameNS(XMLNS.SAML, 'Subject');
  if (subject.length !== 1) {
    throw new Error("Expected 1 Subject; found " + subject.length);
  }
  nameid = subject[0].getElementsByTagNameNS(XMLNS.SAML, 'NameID');
  if (nameid.length !== 1) {
    return null;
  }
  return (ref = nameid[0].firstChild) != null ? ref.data : void 0;
};

get_session_index = function(dom) {
  var assertion, attr, authn_statement, i, len, ref;
  assertion = dom.getElementsByTagNameNS(XMLNS.SAML, 'Assertion');
  if (assertion.length !== 1) {
    throw new Error("Expected 1 Assertion; found " + assertion.length);
  }
  authn_statement = assertion[0].getElementsByTagNameNS(XMLNS.SAML, 'AuthnStatement');
  if (authn_statement.length !== 1) {
    throw new Error("Expected 1 AuthnStatement; found " + authn_statement.length);
  }
  ref = authn_statement[0].attributes;
  for (i = 0, len = ref.length; i < len; i++) {
    attr = ref[i];
    if (attr.name === 'SessionIndex') {
      return attr.value;
    }
  }
  throw new Error("SessionIndex not an attribute of AuthnStatement.");
};

parse_assertion_attributes = function(dom) {
  var assertion, assertion_attributes, attr, attribute, attribute_name, attribute_statement, attribute_values, i, j, len, len1, ref, ref1;
  assertion = dom.getElementsByTagNameNS(XMLNS.SAML, 'Assertion');
  if (assertion.length !== 1) {
    throw new Error("Expected 1 Assertion; found " + assertion.length);
  }
  attribute_statement = assertion[0].getElementsByTagNameNS(XMLNS.SAML, 'AttributeStatement');
  if (!(attribute_statement.length <= 1)) {
    throw new Error("Expected 1 AttributeStatement inside Assertion; found " + attribute_statement.length);
  }
  if (attribute_statement.length === 0) {
    return {};
  }
  assertion_attributes = {};
  ref = attribute_statement[0].getElementsByTagNameNS(XMLNS.SAML, 'Attribute');
  for (i = 0, len = ref.length; i < len; i++) {
    attribute = ref[i];
    ref1 = attribute.attributes;
    for (j = 0, len1 = ref1.length; j < len1; j++) {
      attr = ref1[j];
      if (attr.name === 'Name') {
        attribute_name = attr.value;
      }
    }
    if (attribute_name == null) {
      throw new Error("Invalid attribute without name");
    }
    attribute_values = attribute.getElementsByTagNameNS(XMLNS.SAML, 'AttributeValue');
    assertion_attributes[attribute_name] = _(attribute_values).map(function(attribute_value) {
      var ref2;
      return ((ref2 = attribute_value.childNodes[0]) != null ? ref2.data : void 0) || '';
    });
  }
  return assertion_attributes;
};

pretty_assertion_attributes = function(assertion_attributes) {
  var claim_map;
  claim_map = {
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "email",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname": "given_name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn": "upn",
    "http://schemas.xmlsoap.org/claims/CommonName": "common_name",
    "http://schemas.xmlsoap.org/claims/Group": "group",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/role": "role",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname": "surname",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/privatepersonalidentifier": "ppid",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "name_id",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/authenticationmethod": "authentication_method",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/denyonlysid": "deny_only_group_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/denyonlyprimarysid": "deny_only_primary_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/denyonlyprimarygroupsid": "deny_only_primary_group_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groupsid": "group_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/primarygroupsid": "primary_group_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/primarysid": "primary_sid",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname": "windows_account_name"
  };
  return _(assertion_attributes).chain().pairs().filter(function(arg) {
    var k, v;
    k = arg[0], v = arg[1];
    return (claim_map[k] != null) && v.length > 0;
  }).map(function(arg) {
    var k, v;
    k = arg[0], v = arg[1];
    return [claim_map[k], v[0]];
  }).object().value();
};

parse_authn_response = function(saml_response, sp_private_key, idp_certificates, allow_unencrypted, cb) {
  var decrypted_assertion, user;
  user = {};
  decrypted_assertion = null;
  return async.waterfall([
    /*function(cb_wf) {
      return decrypt_assertion(saml_response, sp_private_key, function(err, result) {
        var assertion;
        if (err == null) {
          return cb_wf(null, result);
        }
        if (!allow_unencrypted) {
          return cb_wf(err, result);
        }
        assertion = saml_response.getElementsByTagNameNS(XMLNS.SAML, 'Assertion');
        if (assertion.length !== 1) {
          return cb_wf(new Error("Expected 1 Assertion or 1 EncryptedAssertion; found " + assertion.length));
        }
        return cb_wf(null, assertion[0].toString());
      });
    }, function(result, cb_wf) {*/
    function(cb_wf){
      var result = saml_response.getElementsByTagNameNS(XMLNS.SAML, 'Assertion')[0].toString();
      debug(result);
      decrypted_assertion = (new xmldom.DOMParser()).parseFromString(result);
      if (!_.some(idp_certificates, function(cert) {
        return check_saml_signature(result, saml_response, cert);
      })) {
        return cb_wf(new Error("SAML Assertion signature check failed! (checked " + idp_certificates.length + " certificate(s))"));
      }
      return cb_wf(null);
    }, function(cb_wf) {
      return async.lift(get_name_id)(decrypted_assertion, cb_wf);
    }, function(name_id, cb_wf) {
      user.name_id = name_id;
      return async.lift(get_session_index)(decrypted_assertion, cb_wf);
    }, function(session_index, cb_wf) {
      user.session_index = session_index;
      return async.lift(parse_assertion_attributes)(decrypted_assertion, cb_wf);
    }, function(assertion_attributes, cb_wf) {
      user = _.extend(user, pretty_assertion_attributes(assertion_attributes));
      user = _.extend(user, {
        attributes: assertion_attributes
      });
      return cb_wf(null, {
        user: user
      });
    }
  ], cb);
};

parse_logout_request = function(dom) {
  var issuer, name_id, ref, ref1, ref2, request, session_index;
  request = dom.getElementsByTagNameNS(XMLNS.SAMLP, "LogoutRequest");
  if (request.length !== 1) {
    throw new Error("Expected 1 LogoutRequest; found " + request.length);
  }
  request = {};
  issuer = dom.getElementsByTagNameNS(XMLNS.SAML, 'Issuer');
  if (issuer.length === 1) {
    request.issuer = (ref = issuer[0].firstChild) != null ? ref.data : void 0;
  }
  name_id = dom.getElementsByTagNameNS(XMLNS.SAML, 'NameID');
  if (name_id.length === 1) {
    request.name_id = (ref1 = name_id[0].firstChild) != null ? ref1.data : void 0;
  }
  session_index = dom.getElementsByTagNameNS(XMLNS.SAMLP, 'SessionIndex');
  if (session_index.length === 1) {
    request.session_index = (ref2 = session_index[0].firstChild) != null ? ref2.data : void 0;
  }
  return request;
};

set_option_defaults = function(request_options, idp_options, sp_options) {
  return _.defaults({}, request_options, idp_options, sp_options);
};

module.exports.ServiceProvider = ServiceProvider = (function() {
  function ServiceProvider(options) {
    this.create_metadata = bind(this.create_metadata, this);
    this.create_logout_request_url = bind(this.create_logout_request_url, this);
    this.entity_id = options.entity_id, this.private_key = options.private_key, this.certificate = options.certificate, this.assert_endpoint = options.assert_endpoint;
    this.shared_options = _.pick(options, "force_authn", "auth_context", "nameid_format", "sign_get_request", "allow_unencrypted_assertion");
  }

  ServiceProvider.prototype.create_login_request_url = function(identity_provider, options, cb) {
    var id, ref, xml;
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    ref = create_authn_request(this.entity_id, this.assert_endpoint, identity_provider.sso_login_url, options.force_authn, options.auth_context, options.nameid_format), id = ref.id, xml = ref.xml;
    return zlib.deflateRaw(xml, (function(_this) {
      return function(err, deflated) {
        var uri;
        if (err != null) {
          return cb(err);
        }
        uri = url.parse(identity_provider.sso_login_url);
        if (options.sign_get_request) {
          uri.query = sign_request(deflated.toString('base64'), _this.private_key, options.relay_state);
        } else {
          uri.query = {
            SAMLRequest: deflated.toString('base64')
          };
          if (options.relay_state != null) {
            uri.query.RelayState = options.relay_state;
          }
        }
        return cb(null, url.format(uri), id);
      };
    })(this));
  };

  ServiceProvider.prototype.create_login_request = function(identity_provider, options, cb) {
    var data, id, ref, uri, xml;
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    ref = create_authn_request(this.entity_id, this.assert_endpoint, identity_provider.sso_login_url, options.force_authn, options.auth_context, options.nameid_format), id = ref.id, xml = ref.xml;
    uri = url.parse(identity_provider.sso_login_url);
    data = {
      SAMLRequest: new Buffer(xml).toString("base64")
    };
    return cb(null, url.format(uri), data, id);

    /*
    zlib.deflateRaw xml, (err, deflated) =>
      return cb err if err?
      uri = url.parse identity_provider.sso_login_url
      data = null
      if options.sign_get_request
        data = sign_request deflated.toString('base64'), @private_key, options.relay_state
      else
        console.log "not signed"
        data = SAMLRequest: deflated.toString 'base64'
        data.RelayState = options.relay_state if options.relay_state?
      cb null, url.format(uri), data, id
     */
  };

  ServiceProvider.prototype.redirect_assert = function(identity_provider, options, cb) {
    options = _.extend(options, {
      get_request: true
    });
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    return this._assert(identity_provider, options, cb);
  };

  ServiceProvider.prototype.post_assert = function(identity_provider, options, cb) {
    options = _.extend(options, {
      get_request: false,
      allow_unencrypted_assertion: false
    });
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    return this._assert(identity_provider, options, cb);
  };

  ServiceProvider.prototype._assert = function(identity_provider, options, cb) {
    var decrypted_assertion, ref, ref1, response, saml_response;
    if (!((((ref = options.request_body) != null ? ref.SAMLResponse : void 0) != null) || (((ref1 = options.request_body) != null ? ref1.SAMLRequest : void 0) != null))) {
      return setImmediate(cb, new Error("Request body does not contain SAMLResponse or SAMLRequest."));
    }
    saml_response = null;
    decrypted_assertion = null;
    response = {};
    return async.waterfall([
      function(cb_wf) {
        var raw;
        raw = new Buffer(options.request_body.SAMLResponse || options.request_body.SAMLRequest, 'base64');
        if (options.get_request) {
          return zlib.inflateRaw(raw, cb_wf);
        }
        return setImmediate(cb_wf, null, raw);
      }, function(response_buffer, cb_wf) {
        debug(saml_response);
        saml_response = (new xmldom.DOMParser()).parseFromString(response_buffer.toString());
        return async.lift(parse_response_header)(saml_response, cb_wf);
      }, (function(_this) {
        return function(response_header, cb_wf) {
          response = {
            response_header: response_header
          };
          switch (false) {
            case saml_response.getElementsByTagNameNS(XMLNS.SAMLP, 'Response').length !== 1:
              if (!check_status_success(saml_response)) {
                cb_wf(new SAMLError("SAML Response was not success!", {
                  status: get_status(saml_response)
                }));
              }
              response.type = 'authn_response';
              return parse_authn_response(saml_response, _this.private_key, identity_provider.certificates, options.allow_unencrypted_assertion, cb_wf);
            case saml_response.getElementsByTagNameNS(XMLNS.SAMLP, 'LogoutResponse').length !== 1:
              if (!check_status_success(saml_response)) {
                cb_wf(new SAMLError("SAML Response was not success!", {
                  status: get_status(saml_response)
                }));
              }
              response.type = 'logout_response';
              return setImmediate(cb_wf, null, {});
            case saml_response.getElementsByTagNameNS(XMLNS.SAMLP, 'LogoutRequest').length !== 1:
              response.type = 'logout_request';
              return setImmediate(cb_wf, null, parse_logout_request(saml_response));
          }
        };
      })(this), function(result, cb_wf) {
        _.extend(response, result);
        return cb_wf(null, response);
      }
    ], cb);
  };

  ServiceProvider.prototype.create_logout_request_url = function(identity_provider, options, cb) {
    var xml;
    if (_.isString(identity_provider)) {
      identity_provider = {
        sso_logout_url: identity_provider,
        options: {}
      };
    }
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    xml = create_logout_request(this.entity_id, options.name_id, options.session_index, identity_provider.sso_logout_url);
    return zlib.deflateRaw(xml, (function(_this) {
      return function(err, deflated) {
        var uri;
        if (err != null) {
          return cb(err);
        }
        uri = url.parse(identity_provider.sso_logout_url);
        if (options.sign_get_request) {
          uri.query = sign_request(deflated.toString('base64'), _this.private_key, options.relay_state);
        } else {
          uri.query = {
            SAMLRequest: deflated.toString('base64')
          };
          if (options.relay_state != null) {
            uri.query.RelayState = options.relay_state;
          }
        }
        return cb(null, url.format(uri));
      };
    })(this));
  };

  ServiceProvider.prototype.create_logout_response_url = function(identity_provider, options, cb) {
    var xml;
    if (_.isString(identity_provider)) {
      identity_provider = {
        sso_logout_url: identity_provider,
        options: {}
      };
    }
    options = set_option_defaults(options, identity_provider.shared_options, this.shared_options);
    xml = create_logout_response(this.entity_id, options.in_response_to, identity_provider.sso_logout_url);
    return zlib.deflateRaw(xml, (function(_this) {
      return function(err, deflated) {
        var uri;
        if (err != null) {
          return cb(err);
        }
        uri = url.parse(identity_provider.sso_logout_url);
        if (options.sign_get_request) {
          uri.query = sign_request(deflated.toString('base64'), _this.private_key, options.relay_state, true);
        } else {
          uri.query = {
            SAMLResponse: deflated.toString('base64')
          };
          if (options.relay_state != null) {
            uri.query.RelayState = options.relay_state;
          }
        }
        return cb(null, url.format(uri));
      };
    })(this));
  };

  ServiceProvider.prototype.create_metadata = function() {
    return create_metadata(this.entity_id, this.assert_endpoint, this.certificate, this.certificate);
  };

  return ServiceProvider;

})();

module.exports.IdentityProvider = IdentityProvider = (function() {
  function IdentityProvider(options) {
    this.sso_login_url = options.sso_login_url, this.sso_logout_url = options.sso_logout_url, this.certificates = options.certificates;
    if (!_.isArray(this.certificates)) {
      this.certificates = [this.certificates];
    }
    this.shared_options = _.pick(options, "force_authn", "sign_get_request", "allow_unencrypted_assertion");
  }

  return IdentityProvider;

})();

if (process.env.NODE_ENV === "test") {
  module.exports.create_authn_request = create_authn_request;
  module.exports.create_metadata = create_metadata;
  module.exports.format_pem = format_pem;
  module.exports.sign_request = sign_request;
  module.exports.check_saml_signature = check_saml_signature;
  module.exports.check_status_success = check_status_success;
  module.exports.pretty_assertion_attributes = pretty_assertion_attributes;
  module.exports.decrypt_assertion = decrypt_assertion;
  module.exports.parse_response_header = parse_response_header;
  module.exports.parse_logout_request = parse_logout_request;
  module.exports.get_name_id = get_name_id;
  module.exports.get_session_index = get_session_index;
  module.exports.parse_assertion_attributes = parse_assertion_attributes;
  module.exports.set_option_defaults = set_option_defaults;
}