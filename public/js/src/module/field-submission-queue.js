import $ from 'jquery';
import MD5 from 'crypto-js/md5';
import settings from './settings';
import { t } from './translator';
import utils from './utils';
import gui from './gui';

const FIELDSUBMISSION_URL = settings.enketoId
    ? `${settings.basePath}/fieldsubmission/${
          settings.enketoId
      }${utils.getQueryString({ name: 'ecid', value: settings.ecid })}`
    : null;
const FIELDSUBMISSION_2_URL = settings.enketoId
    ? `${settings.basePath}/fieldsubmission/${
          settings.enketoId
      }/ecid/${encodeURIComponent(settings.ecid)}`
    : null;
const FIELDSUBMISSION_COMPLETE_URL = settings.enketoId
    ? `${settings.basePath}/fieldsubmission/complete/${
          settings.enketoId
      }${utils.getQueryString({ name: 'ecid', value: settings.ecid })}`
    : null;

class FieldSubmissionQueue {
    constructor() {
        this.submissionQueue = {};
        this.submissionOngoing = null;
        this.lastAdded = {};
        this.repeatRemovalCounter = 0;
        this.submittedCounter = 0;
        this._enabled = false;

        // TODO: move outside of constructor
        /**
         * Shows upload progress
         *
         * @type {object}
         */
        this._uploadStatus = {
            init() {
                if (!this._$box) {
                    this._$box = $('<div class="fieldsubmission-status"/>')
                        .prependTo('.form-header')
                        .add(
                            $(
                                '<div class="form-footer__feedback fieldsubmission-status"/>'
                            ).prependTo('.form-footer')
                        );
                }
            },
            _getBox() {
                return this._$box;
            },
            _getText(status) {
                return {
                    ongoing: t('fieldsubmission.feedback.ongoing'),
                    success: t('fieldsubmission.feedback.success'),
                    fail: t('fieldsubmission.feedback.fail'),
                    disabled: t('fieldsubmission.feedback.disabled'),
                }[status];
            },
            _updateClass(status) {
                this._getBox()
                    .removeClass('ongoing success error fail')
                    .addClass(status)
                    .text(this._getText(status));
            },
            update(status) {
                // if ( /\/fs\/dnc?\//.test( window.location.pathname ) ) {
                //    return;
                // }
                this._updateClass(status);
            },
        };

        this._uploadStatus.init();
    }

    get enabled() {
        return this._enabled;
    }

    enable() {
        // Tbc if this is the best approach. The ability to add submissions to the queue is still there,
        // but they can no longer be submitted.
        // console.log( 'fieldsubmissions have been enabled' );
        this._enabled = true;
    }

    get() {
        return this.submissionQueue;
    }

    // This still follows the old API: https://app.swaggerhub.com/apis-docs/martijnr/openclinica-fieldsubmission/1.0.0
    addFieldSubmission(fieldPath, xmlFragment, instanceId, deprecatedId, file) {
        let fd;

        if (this._duplicateCheck(fieldPath, xmlFragment)) {
            return;
        }

        fd = new FormData();

        if (fieldPath && xmlFragment && instanceId) {
            fd.append('instance_id', instanceId);
            fd.append(
                'xml_submission_fragment_file',
                new Blob([xmlFragment], {
                    type: 'text/xml',
                }),
                'xml_submission_fragment_file.xml'
            );

            if (file && file instanceof Blob) {
                fd.append(file.name, file, file.name);
            }

            if (deprecatedId) {
                fd.append('deprecated_id', deprecatedId);
            }

            this.submissionQueue[`POST_${fieldPath}_${Date.now()}`] = fd;
        } else {
            console.error(
                'Attempt to add field submission without path, XML fragment or instanceID'
            );
        }
    }

    // This follows the new API: https://app.swaggerhub.com/apis-docs/martijnr/openclinica-fieldsubmission/2.0.0
    addRepeatRemoval(repeatNodeName, repeatOrdinal, instanceId) {
        // No duplicate check necessary for deleting as the event should only fire once.

        if (repeatNodeName && repeatOrdinal) {
            this.submissionQueue[`DELETE_${this.repeatRemovalCounter++}`] = {
                instance: instanceId,
                repeat: repeatNodeName,
                ordinal: repeatOrdinal,
            };
        } else {
            console.error(
                'Attempt to add repeat removal request without repeat name or repeat ordinal'
            );
        }
    }

    submitAll(previousFailed = false) {
        if (!this._enabled) {
            this._uploadStatus.update('disabled');

            return Promise.resolve();
        }

        if (this.submissionOngoing) {
            return this.submissionOngoing;
        }

        const key = Object.keys(this.submissionQueue)[0];

        if (key) {
            let failed = false;
            const fd = this.submissionQueue[key];
            delete this.submissionQueue[key];
            this._uploadStatus.update('ongoing');
            this._clearSubmissionInterval();
            const keyParts = key.split('_');
            const method = keyParts[0];
            const url =
                method === 'DELETE'
                    ? `${FIELDSUBMISSION_2_URL}/instance/${encodeURIComponent(
                          fd.instance
                      )}/repeat-group/${encodeURIComponent(
                          fd.repeat
                      )}/ordinal/${encodeURIComponent(fd.ordinal)}`
                    : FIELDSUBMISSION_URL;

            this.submissionOngoing = this._submitOne(url, fd, method)
                .catch((error) => {
                    failed = true;
                    console.debug(
                        'failed to submit ',
                        key,
                        'adding it back to the queue, error:',
                        error
                    );
                    // add back to the fieldSubmission queue if the field value wasn't overwritten in the mean time
                    if (typeof this.submissionQueue[key] === 'undefined') {
                        this.submissionQueue[key] = fd;
                    }
                    if (error.status === 401) {
                        gui.confirmLogin();
                    }

                    return error;
                })
                .catch((error) => {
                    console.error('Unexpected error:', error.message);
                })
                .then(() => {
                    const status = failed ? 'fail' : 'success';
                    this._uploadStatus.update(status);
                    this.submissionOngoing = null;
                    this._resetSubmissionInterval();

                    if (failed && previousFailed) {
                        // After 2 subsequent failures, give up for now, and let the interval schedule the next attempt
                        // to avoid infinite immediate retries.
                        return true;
                    }
                    if (!failed) {
                        console.log(
                            'Submitted one field. Current remaining queue is',
                            this.submissionQueue
                        );
                    }

                    // Submit sequentially
                    return this.submitAll(failed);
                });

            return this.submissionOngoing;
        }
        return Promise.resolve();
    }

    _submitOne(url, fd = null, method = 'POST') {
        const that = this;
        let error;

        return new Promise((resolve, reject) => {
            $.ajax(url, {
                type: method,
                data: fd,
                cache: false,
                contentType: false,
                processData: false,
                headers: {
                    'X-OpenClinica-Version': '1.0',
                },
                timeout: 3 * 60 * 1000,
            })
                .done((data, textStatus, jqXHR) => {
                    if (jqXHR.status === 201 || jqXHR.status === 202) {
                        that.submittedCounter =
                            jqXHR.status === 201
                                ? that.submittedCounter + 1
                                : that.submittedCounter;
                        resolve(jqXHR.status);
                    } else {
                        throw jqXHR;
                    }
                })
                .fail((jqXHR) => {
                    error = new Error(jqXHR.statusText);
                    error.status = jqXHR.status;
                    if (jqXHR.status === 409) {
                        gui.alert(
                            t('fieldsubmission.alert.locked.msg'),
                            t('fieldsubmission.alert.locked.heading')
                        );
                    }
                    reject(error);
                });
        });
    }

    complete(instanceId, deprecatedId) {
        if (!this._enabled) {
            this._uploadStatus('disabled');

            return Promise.reject(
                new Error(
                    'Attempt to complete a record for a form that was disabled.'
                )
            );
        }

        if (Object.keys(this.submissionQueue).length === 0 && instanceId) {
            const fd = new FormData();
            fd.append('instance_id', instanceId);

            if (deprecatedId) {
                fd.append('deprecated_id', deprecatedId);
            }

            return this._submitOne(
                FIELDSUBMISSION_COMPLETE_URL,
                fd,
                'POST'
            ).then(() => true);
        }
        const error = new Error(
            'Attempt to make a "complete" request when queue is not empty or instanceId is missing',
            this.submissionQueue,
            instanceId
        );
        console.error(error);

        return Promise.reject(error);
    }

    _resetSubmissionInterval() {
        this._clearSubmissionInterval();
        this.submissionInterval = setInterval(() => {
            this.submitAll();
        }, 1 * 60 * 1000);
    }

    _clearSubmissionInterval() {
        clearInterval(this.submissionInterval);
    }

    _duplicateCheck(path, fragment) {
        const hash = MD5(fragment).toString();
        if (this.lastAdded[path] !== hash) {
            this.lastAdded[path] = hash;

            return false;
        }

        return true;
    }
}

export default FieldSubmissionQueue;
