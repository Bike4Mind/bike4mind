import { Box, Typography } from '@mui/joy';
import type { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import './markdown/observatory.css';

interface RapidReplyBubbleProps {
  chatCompletion: ReturnType<typeof useSubscribeChatCompletion>['chatCompletion'];
}

/** The instant acknowledgement shown while the real answer is still streaming.
 *  Rendered above the streaming reply body so the transcript reads in the order
 *  the two responses were produced. */
const RapidReplyBubble = ({ chatCompletion }: RapidReplyBubbleProps) => {
  const isMobile = useIsMobile();
  const rapidReply = chatCompletion.rapidReply;
  if (!rapidReply || rapidReply.status === 'replaced' || !chatCompletion.statusMessage) return null;

  return (
    <Box
      className="rapid-reply-container"
      data-testid="rapid-reply-container"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        mt: 2,
        mb: 1,
        p: 2,
        // Unframed, matching the reply body below it: the two are the same voice,
        // and the spinner under the streaming reply already carries progress.
        backgroundColor: 'transparent',
        borderRadius: '8px',
        position: 'relative',
      }}
    >
      {/* Level and color mirror the reply body's wrapper in PromptReplies, so the
          two set the same base size for observatory.css's em-based scale. */}
      <Typography level={isMobile ? 'body-sm' : 'body-md'} component="div" sx={{ color: 'text.primary' }}>
        {/* Same reading treatment as the reply below. The class goes on a plain
            <div>, never on the Typography: Joy's emotion class on that element
            would tie on specificity and win on injection order. Content is plain
            text, not markdown, so it is a single hand-written <p>. */}
        <div className="b4m-md">
          <p style={{ whiteSpace: 'pre-wrap' }}>{rapidReply.content}</p>
        </div>
      </Typography>
    </Box>
  );
};

export default RapidReplyBubble;
