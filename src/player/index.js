import {DEFAULT_PLAYER_OPTIONS, EVENTS, EVENTS_ERROR} from "../constant";
import Debug from "../utils/debug";
import Events from "../utils/events";
import property from './property';
import events from './events';
import {fpsStatus, isFullScreen, now, supportMSE, supportOffscreenV2, supportWCS} from "../utils";
import Video from "../video";
import Audio from "../audio";
import Stream from "../stream";
import Recorder from "../recorder";
import DecoderWorker from "../worker/index";
import Emitter from "../utils/emitter";
import Demux from "../demux";
import WebcodecsDecoder from "../decoder/webcodecs";
import Control from "../control";
import './style.scss'
import observer from "./observer";
import MseDecoder from "../decoder/mse";

export default class Player extends Emitter {
    constructor(container, options) {
        super()
        this.$container = container;
        this._opt = Object.assign({}, DEFAULT_PLAYER_OPTIONS, options)
        this.debug = new Debug(this);


        if (this._opt.useWCS) {
            this._opt.useWCS = supportWCS();
        }

        if (this._opt.useMSE) {
            this._opt.useMSE = supportMSE();
        }

        // 如果使用mse则强制不允许 webcodecs
        if (this._opt.useMSE) {
            if (this._opt.useWCS) {
                this.debug.log('Player', 'useWCS set true->false')
            }

            if (!this._opt.forceNoOffscreen) {
                this.debug.log('Player', 'forceNoOffscreen set false->true')
            }

            this._opt.useWCS = false;
            this._opt.forceNoOffscreen = true;
        }


        if (!this._opt.forceNoOffscreen) {
            if (!supportOffscreenV2()) {
                this._opt.forceNoOffscreen = true;
                this._opt.useOffscreen = false;
            } else {
                this._opt.useOffscreen = true;
            }
        }


        this._opt.hasControl = this._hasControl();
        //
        this._loading = false;
        this._playing = false;
        this._hasLoaded = false;

        //
        this._checkHeartTimeout = null;
        this._checkLoadingTimeout = null;

        //
        this._startBpsTime = null;
        this._isPlayingBeforePageHidden = false;
        this._stats = {
            buf: 0, // 当前缓冲区时长，单位毫秒,
            fps: 0, // 当前视频帧率
            abps: '', // 当前音频码率，单位bit
            vbps: '', // 当前视频码率，单位bit
            ts: '' // 当前视频帧pts，单位毫秒
        }

        this._wakeLock = null;

        property(this);

        this.events = new Events(this);
        this.video = new Video(this);
        this.audio = new Audio(this);
        this.recorder = new Recorder(this);
        this.decoderWorker = new DecoderWorker(this);


        this.stream = null;
        this.demux = null;


        if (this._opt.useWCS) {
            this.webcodecsDecoder = new WebcodecsDecoder(this)
        }

        if (this._opt.useMSE) {
            this.mseDecoder = new MseDecoder(this);
        }

        //
        this.control = new Control(this);


        events(this);
        observer(this);

        if (this._opt.isNotMute) {
            this.mute(true);
        }

        this.enableWakeLock();

        if (this._opt.useWCS) {
            this.debug.log('Player', 'use WCS')
        }

        if (this._opt.useMSE) {
            this.debug.log('Player', 'use MSE')
        }

        if (this._opt.useOffscreen) {
            this.debug.log('Player', 'use offscreen')
        }

        this.debug.log('Player options', this._opt);
    }


    set fullscreen(value) {
        this.emit(EVENTS.fullscreen, value);
    }

    get fullscreen() {
        return isFullScreen() || this.webFullscreen;
    }

    set webFullscreen(value) {
        this.emit(EVENTS.webFullscreen, value);
    }

    get webFullscreen() {
        return this.$container.classList.contains('jessibuca-fullscreen-web')
    }

    get loaded() {
        return this._hasLoaded;
    }

    //
    set playing(value) {

        if (value) {
            // 将loading 设置为 false
            this.loading = false;
        }

        if (this.playing !== value) {
            this._playing = value;
            this.emit(EVENTS.playing, value);
            this.emit(EVENTS.volumechange, this.volume);

            if (value) {
                this.emit(EVENTS.play);
            } else {
                this.emit(EVENTS.pause);
            }
        }

    }

    get playing() {
        return this._playing;
    }

    get volume() {
        return this.audio.volume;
    }

    set volume(value) {
        this.audio.setVolume(value);
    }

    set loading(value) {
        if (this.loading !== value) {
            this._loading = value;
            this.emit(EVENTS.loading, this._loading);
        }
    }

    get loading() {
        return this._loading;
    }

    set recording(value) {
        if (this.playing) {
            if (value) {
                this.recorder.startRecord();
            } else {
                this.recorder.stopRecordAndSave();
            }
        }
    }

    get recording() {
        return this.recorder.recording;
    }


    /**
     *
     * @param options
     */
    updateOption(options) {
        this._opt = Object.assign({}, this._opt, options)
    }

    /**
     *
     * @returns {Promise<unknown>}
     */
    init() {
        return new Promise((resolve, reject) => {
            if (!this.stream) {
                this.stream = new Stream(this);
            }

            if (!this.demux) {
                this.demux = new Demux(this);
            }

            if (this._opt.useWCS) {
                if (!this.webcodecsDecoder) {
                    this.webcodecsDecoder = new WebcodecsDecoder(this)
                }
            }

            if (this._opt.useMSE) {
                if (!this.mseDecoder) {
                    this.mseDecoder = new MseDecoder(this);
                }
            }

            if (!this.decoderWorker) {
                this.decoderWorker = new DecoderWorker(this);

                this.once(EVENTS.decoderWorkerInit, () => {
                    resolve()
                })
            } else {
                resolve()
            }

        })
    }


    /**
     *
     * @param url
     * @returns {Promise<unknown>}
     */
    play(url) {
        return new Promise((resolve, reject) => {
            if (!url && !this._opt.url) {
                return reject();
            }

            this.loading = true;
            this.playing = false;
            if (!url) {
                url = this._opt.url;
            }
            this._opt.url = url;

            this.clearCheckHeartTimeout();
            this.init().then(() => {
                this.stream.fetchStream(url);

                if (this._opt.useMSE) {
                    this.video.play();
                }
                //
                this.checkLoadingTimeout();
                // fetch error
                this.stream.once(EVENTS_ERROR.fetchError, (error) => {
                    reject(error)
                })

                // ws
                this.stream.once(EVENTS_ERROR.websocketError, (error) => {
                    reject(error)
                })

                // success
                this.stream.once(EVENTS.streamSuccess, () => {
                    resolve();
                })
            }).catch((e) => {
                reject(e)
            })
        })
    }

    /**
     *
     */
    close() {
        return new Promise((resolve, reject) => {
            this._close().then(() => {
                this.video.clearView();
                resolve()
            })
        })
    }

    _close() {
        return new Promise((resolve, reject) => {
            //
            if (this.stream) {
                this.stream.destroy();
                this.stream = null;
            }

            if (this.demux) {
                this.demux.destroy();
                this.demux = null;
            }

            //
            if (this.decoderWorker) {
                this.decoderWorker.destroy();
                this.decoderWorker = null;
            }

            if (this.webcodecsDecoder) {
                this.webcodecsDecoder.destroy();
                this.webcodecsDecoder = null;
            }

            if (this.mseDecoder) {
                this.mseDecoder.destroy();
                this.mseDecoder = null;
            }


            this.clearCheckHeartTimeout();
            this.clearCheckLoadingTimeout();
            this.playing = false;
            this.loading = false;
            this.recording = false;
            // 声音要清除掉。。。。
            this.audio.pause();
            setTimeout(() => {
                resolve()
            }, 0)
        })
    }

    /**
     *
     * @param flag {boolean} 是否清除画面
     * @returns {Promise<unknown>}
     */
    pause(flag) {
        if (flag) {
            return this.close();
        } else {
            return this._close();
        }
    }

    /**
     *
     * @param flag
     */
    mute(flag) {
        this.audio.mute(flag)
    }

    /**
     *
     */
    resize() {
        this.video.resize();
    }

    /**
     *
     * @param fileName
     */
    startRecord(fileName) {
        if (this.recording) {
            return;
        }

        this.recorder.setFileName(fileName);
        this.recording = true;
    }

    /**
     *
     */
    stopRecordAndSave() {
        if (this.recording) {
            this.recording = false;
        }
    }

    _hasControl() {
        let result = false;

        let hasBtnShow = false;
        Object.keys(this._opt.operateBtns).forEach((key) => {
            if (this._opt.operateBtns[key]) {
                hasBtnShow = true;
            }
        });

        if (this._opt.showBandwidth || this._opt.text || hasBtnShow) {
            result = true;
        }

        return result;
    }

    checkHeart() {
        this.clearCheckHeartTimeout();
        this.checkHeartTimeout();
    }

    // 心跳检查，如果渲染间隔暂停了多少时间之后，就会抛出异常
    checkHeartTimeout() {
        this._checkHeartTimeout = setTimeout(() => {
            this.pause().then(() => {
                this.emit(EVENTS.timeout, 'heart timeout');
            });
        }, this._opt.timeout * 1000)
    }

    //
    clearCheckHeartTimeout() {
        if (this._checkHeartTimeout) {
            clearTimeout(this._checkHeartTimeout);
            this._checkHeartTimeout = null;
        }
    }

    // loading 等待时间
    checkLoadingTimeout() {
        this._checkLoadingTimeout = setTimeout(() => {
            this.pause().then(() => {
                this.emit(EVENTS.timeout, 'loading timeout');
            });
        }, this._opt.timeout * 1000)
    }

    clearCheckLoadingTimeout() {
        if (this._checkLoadingTimeout) {
            clearTimeout(this._checkLoadingTimeout);
            this._checkLoadingTimeout = null;
        }
    }

    handleRender() {
        if (this.loading) {
            this.emit(EVENTS.start);
            this.loading = false;
            this.clearCheckLoadingTimeout();
        }
        if (!this.playing) {
            this.playing = true;
        }
        this.checkHeart();
    }


    //
    updateStats(options) {
        options = options || {};

        if (!this._startBpsTime) {
            this._startBpsTime = now();
        }

        const _nowTime = now();
        const timestamp = _nowTime - this._startBpsTime;

        if (timestamp < 1 * 1000) {
            this._stats.fps += 1;
            return;
        }
        this._stats.ts = options.ts;
        this._stats.buf = options.buf;
        this.emit(EVENTS.stats, this._stats);
        this.emit(EVENTS.performance, fpsStatus(this._stats.fps));
        this._stats.fps = 0;
        this._startBpsTime = _nowTime;
    }

    resetStats() {
        this._startBpsTime = null;
        this._stats = {
            buf: 0, //ms
            fps: 0,
            abps: '',
            vbps: '',
            ts: ''
        }
    }

    enableWakeLock() {
        if (this._opt.keepScreenOn) {
            if ("wakeLock" in navigator) {
                navigator.wakeLock.request("screen").then((lock) => {
                    this._wakeLock = lock;
                })
            }
        }
    }

    releaseWakeLock() {
        if (this._wakeLock) {
            this._wakeLock.release();
            this._wakeLock = null;
        }
    }


    destroy() {
        if (this.events) {
            this.events.destroy();
            this.events = null;
        }
        if (this.decoderWorker) {
            this.decoderWorker.destroy();
            this.decoderWorker = null;
        }
        if (this.video) {
            this.video.destroy();
            this.video = null;
        }
        if (this.audio) {
            this.audio.destroy();
            this.audio = null;
        }

        if (this.stream) {
            this.stream.destroy();
            this.stream = null;
        }

        if (this.recorder) {
            this.recorder.destroy();
            this.recorder = null;
        }

        if (this.control) {
            this.control.destroy();
            this.control = null;
        }

        this._loading = false;
        this._playing = false;
        this._hasLoaded = false;

        this.clearCheckHeartTimeout();
        this.clearCheckLoadingTimeout();

        this.releaseWakeLock();

        // 其他没法解耦的，通过 destroy 方式
        this.emit('destroy');
        // 接触所有绑定事件
        this.off();

        this.debug.log('play', 'destroy end');
    }

}