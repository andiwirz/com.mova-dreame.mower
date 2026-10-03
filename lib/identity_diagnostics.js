'use strict';

// No raw response string, header, device/account ID, token, or endpoint URL
// is returned from this module. Unknown vendor text is classified only.
const KNOWN_MESSAGE_CLASSES = new Map([
  ['设备三元组不存在','device_triple_missing_message'],
  ['the device triple does not exist','device_triple_missing_message'],
  ['device triple does not exist','device_triple_missing_message'],
  ['用户对该设备无权限','device_permission_denied_message'],
  ['user has no permission for this device','device_permission_denied_message'],
  ['user does not have permission for this device','device_permission_denied_message'],
]);

function hostFamily(value) {
  const host=String(value ?? '').trim().toLowerCase();
  if (/(?:^|\.)iot\.dreame\.tech(?::\d{1,5})?$/.test(host)) return 'dreame';
  if (/(?:^|\.)iot\.mova-tech\.com(?::\d{1,5})?$/.test(host)) return 'mova';
  return 'unknown';
}

function cloudEndpointContext(brand, region, configuredSuffix, bindFamily) {
  const configuredFamily=hostFamily(configuredSuffix);
  const validRegion=typeof region==='string' && /^(?:eu|cn|us|sg|ru|de|in|hk|tw|au|uk|jp)$/.test(region);
  const bindDomainFamily=['dreame','mova'].includes(bindFamily) ? bindFamily : 'unknown';
  return {
    configuredBrand:['dreame','mova'].includes(brand)?brand:'unknown',
    region:validRegion?region:'other_redacted',
    configuredHostFamily:configuredFamily,
    bindDomainFamily,
    familyMatch: bindDomainFamily === 'unknown' || configuredFamily === 'unknown' ? 'unverified'
      : (configuredFamily === bindDomainFamily ? 'same_family' : 'different_family'),
    // Host-family agreement is NOT proof of matching login tenant or video provisioning.
    tenantVerified:false,
  };
}

function vendorMessageClass(response) {
  if (!response || typeof response !== 'object') return 'not_available';
  // Only recognized vendor error-message keys; never stringify the full response.
  const messages=[response.msg,response.message,response.data?.msg,response.data?.message];
  let present=false;
  for (const item of messages) {
    if (typeof item !== 'string' || !item.trim()) continue;
    present=true;
    const category=KNOWN_MESSAGE_CLASSES.get(item.trim().toLowerCase());
    if (category) return category;
  }
  return present?'unrecognized_redacted':'absent';
}

function summarizeCloudReply(response,httpStatus=null) {
  const code=response?.code;
  return {
    httpStatus:Number.isInteger(httpStatus) && httpStatus>=100 && httpStatus<=599 ? httpStatus : null,
    vendorCode:Number.isSafeInteger(code) && code>=-999999 && code<=999999 ? code : null,
    success:response?.success === true ? true : (response?.success === false ? false : null),
    vendorMessageClass:vendorMessageClass(response),
  };
}

function safeTransportError(error) {
  const allowed = new Set(['ETIMEDOUT','ESOCKETTIMEDOUT','ECONNRESET','ECONNREFUSED',
    'ENOTFOUND','EAI_AGAIN','ERR_TLS_CERT_ALTNAME_INVALID']);
  if (allowed.has(error?.code)) return error.code;
  // Does not forward Error.message: it may include a URL or a raw cloud body.
  return 'other_redacted';
}

function summarizeEligibility(response) {
  if (response?.code !== 0) return null;
  const value=response?.data?.data?.isDevUser ?? response?.data?.isDevUser;
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  return null;
}

module.exports={hostFamily,cloudEndpointContext,vendorMessageClass,summarizeCloudReply,safeTransportError,summarizeEligibility};
