import {plugin, muxrpc} from 'secret-stack-decorators';

@plugin('1.0.0')
export class Gossip {
  private readonly ssb: any;

  constructor(ssb: any) {
    this.ssb = ssb;
  }

  @muxrpc('duplex', {anonymous: 'allow'})
  public ping = () => this.ssb.conn.ping();
}
