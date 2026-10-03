#ifndef NODELAB_CANDIDATE_PACKET_H
#define NODELAB_CANDIDATE_PACKET_H
/* Pure read-only parser for the known 134-byte XNET character-list format.
   Never modifies data or assumes that the candidate belongs to the mower. */
static int nodelab_candidate_tlv(const unsigned char *p, unsigned long n,
                                 unsigned long *offset, unsigned *port,
                                 unsigned char ip[4]) {
  if (!p || n != 134 || !offset || !port || !ip ||
      p[0] != 0x04 || p[1] != 0xff || p[2] != 0x00 || p[3] != 0x82 || p[4] != 0x04)
    return 0;
  for (unsigned long i = 5; i + 14 <= n; ++i) {
    if (p[i] == 0x04 && p[i+1] == 0x50 && p[i+2] == 0x00 && p[i+3] == 0x10 &&
        p[i+4] == 0x00 && p[i+5] == 0x00 && p[i+6] == 0x04 && p[i+7] == 0x00) {
      *offset = i;
      *port = ((unsigned)p[i+8] << 8) | p[i+9];
      for (unsigned j = 0; j < 4; ++j) ip[j] = p[i+10+j];
      return 1;
    }
  }
  return 0;
}
#endif
